#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <bcrypt.h>
#include <psapi.h>
#include <winternl.h>

#include <node_api.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cwctype>
#include <iomanip>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace {

constexpr uint32_t kBootstrapAbiVersion = 2;
constexpr size_t kMaximumImageBytes = 32U * 1024U * 1024U;
constexpr const char* kBootstrapVersion = "sei.predictive-native-bootstrap@2";
int kBootstrapModuleAnchor = 0;

#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif

class BootstrapError final : public std::runtime_error {
 public:
  BootstrapError(std::string reason, std::string message)
      : std::runtime_error(std::move(message)), reason_(std::move(reason)) {}
  const std::string& reason() const { return reason_; }

 private:
  std::string reason_;
};

void CheckNapi(napi_env env, napi_status status, const char* operation) {
  if (status == napi_ok) return;
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string detail = operation;
  if (info != nullptr && info->error_message != nullptr) {
    detail += ": ";
    detail += info->error_message;
  }
  throw BootstrapError("NAPI", detail);
}

napi_value ThrowBootstrap(napi_env env, const BootstrapError& error) {
  napi_value message;
  napi_value js_error;
  napi_value code;
  napi_value reason;
  napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &js_error);
  napi_create_string_utf8(env, "FAIL-PREDICTIVE-NATIVE-LOADER", NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, js_error, "code", code);
  napi_create_string_utf8(env, error.reason().c_str(), error.reason().size(), &reason);
  napi_set_named_property(env, js_error, "reason", reason);
  napi_throw(env, js_error);
  return nullptr;
}

template <typename Callback>
napi_value Guard(napi_env env, Callback&& callback) {
  try {
    return callback();
  } catch (const BootstrapError& error) {
    return ThrowBootstrap(env, error);
  } catch (const std::exception& error) {
    return ThrowBootstrap(env, BootstrapError("INTERNAL", error.what()));
  } catch (...) {
    return ThrowBootstrap(env, BootstrapError("INTERNAL", "unknown trusted-loader failure"));
  }
}

std::string WindowsFailure(const char* operation, DWORD code = GetLastError()) {
  std::ostringstream stream;
  stream << operation << " failed (win32=" << code << ')';
  return stream.str();
}

std::string NtFailure(const char* operation, NTSTATUS status) {
  std::ostringstream stream;
  stream << operation << " failed (ntstatus=0x" << std::hex << static_cast<uint32_t>(status) << ')';
  return stream.str();
}

class UniqueHandle final {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE handle) : handle_(handle) {}
  ~UniqueHandle() { Reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.Release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) Reset(other.Release());
    return *this;
  }
  HANDLE Get() const { return handle_; }
  HANDLE Release() {
    HANDLE result = handle_;
    handle_ = INVALID_HANDLE_VALUE;
    return result;
  }
  void Reset(HANDLE handle = INVALID_HANDLE_VALUE) {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
    handle_ = handle;
  }

 private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
};

class UniqueView final {
 public:
  explicit UniqueView(void* address) : address_(address) {}
  ~UniqueView() {
    if (address_ != nullptr) UnmapViewOfFile(address_);
  }
  UniqueView(const UniqueView&) = delete;
  UniqueView& operator=(const UniqueView&) = delete;
  void* Get() const { return address_; }

 private:
  void* address_ = nullptr;
};

using NtCreateFileFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtAreMappedFilesTheSameFunction = NTSTATUS(NTAPI*)(PVOID, PVOID);

NtCreateFileFunction ResolveNtCreateFile() {
  static NtCreateFileFunction function = [] {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    return module == nullptr ? nullptr : reinterpret_cast<NtCreateFileFunction>(GetProcAddress(module, "NtCreateFile"));
  }();
  if (function == nullptr) throw BootstrapError("UNSUPPORTED", "NtCreateFile is unavailable");
  return function;
}

NtAreMappedFilesTheSameFunction ResolveNtAreMappedFilesTheSame() {
  static NtAreMappedFilesTheSameFunction function = [] {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    return module == nullptr ? nullptr : reinterpret_cast<NtAreMappedFilesTheSameFunction>(
        GetProcAddress(module, "NtAreMappedFilesTheSame"));
  }();
  if (function == nullptr) {
    throw BootstrapError("UNSUPPORTED", "NtAreMappedFilesTheSame is unavailable for exact loaded-image proof");
  }
  return function;
}

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) throw BootstrapError("INVALID_PATH", "image path is not valid UTF-8");
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), result.data(), length) != length) {
    throw BootstrapError("INVALID_PATH", "image path conversion failed");
  }
  return result;
}

std::string Utf8(napi_env env, napi_value value, const char* label) {
  napi_valuetype type;
  CheckNapi(env, napi_typeof(env, value, &type), "inspect string");
  if (type != napi_string) throw BootstrapError("INVALID_ARGUMENT", std::string(label) + " must be a string");
  size_t length = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "measure string");
  std::string result(length + 1, '\0');
  size_t copied = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, result.data(), length + 1, &copied), "read string");
  result.resize(copied);
  if (result.find('\0') != std::string::npos) throw BootstrapError("INVALID_PATH", std::string(label) + " contains NUL");
  return result;
}

bool ClosedWindowsComponent(const std::wstring& component) {
  if (component.empty() || component.size() > 255 || component == L"." || component == L"..") return false;
  if (component.find_first_of(L"\\/:") != std::wstring::npos || component.back() == L'.' || component.back() == L' ') return false;
  std::wstring basename = component.substr(0, component.find(L'.'));
  std::transform(basename.begin(), basename.end(), basename.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(towupper(character));
  });
  if (basename == L"CON" || basename == L"PRN" || basename == L"AUX" || basename == L"NUL") return false;
  return !(basename.size() == 4 && (basename.rfind(L"COM", 0) == 0 || basename.rfind(L"LPT", 0) == 0)
      && basename[3] >= L'1' && basename[3] <= L'9');
}

struct ParsedImagePath {
  std::wstring device_target;
  std::vector<std::wstring> components;
  std::wstring global_path;
};

struct ParsedMappedImagePath {
  std::wstring device_root;
  std::vector<std::wstring> components;
};

ParsedImagePath ParseImagePath(const std::string& utf8_path) {
  const std::wstring path = Wide(utf8_path);
  if (path.find(L'/') != std::wstring::npos || path.size() < 3 || path[0] < L'A' || path[0] > L'Z'
      || path[1] != L':' || path[2] != L'\\' || (path.size() > 3 && path.back() == L'\\')) {
    throw BootstrapError("INVALID_PATH", "helper image must use one canonical uppercase-drive DOS absolute spelling");
  }
  std::wstring drive_name{path[0], L':'};
  const std::wstring drive_root = drive_name + L"\\";
  if (GetDriveTypeW(drive_root.c_str()) != DRIVE_FIXED) {
    throw BootstrapError("UNSUPPORTED_ROOT", "helper image must be on a local fixed drive");
  }
  std::array<wchar_t, 32768> device_buffer{};
  if (QueryDosDeviceW(drive_name.c_str(), device_buffer.data(), static_cast<DWORD>(device_buffer.size())) == 0) {
    throw BootstrapError("IO", WindowsFailure("resolve helper-image drive"));
  }
  const std::wstring device_target(device_buffer.data());
  constexpr wchar_t kPrefix[] = L"\\Device\\HarddiskVolume";
  constexpr size_t kPrefixLength = (sizeof(kPrefix) / sizeof(wchar_t)) - 1;
  if (device_target.size() <= kPrefixLength
      || CompareStringOrdinal(device_target.data(), static_cast<int>(kPrefixLength),
          kPrefix, static_cast<int>(kPrefixLength), TRUE) != CSTR_EQUAL
      || !std::all_of(device_target.begin() + kPrefixLength, device_target.end(), [](wchar_t character) {
        return character >= L'0' && character <= L'9';
      })) {
    throw BootstrapError("UNSUPPORTED_ROOT", "helper-image drive is not an exact physical local volume");
  }
  std::vector<std::wstring> components;
  size_t start = 3;
  while (start < path.size()) {
    size_t end = path.find(L'\\', start);
    if (end == std::wstring::npos) end = path.size();
    const std::wstring component = path.substr(start, end - start);
    if (!ClosedWindowsComponent(component)) {
      throw BootstrapError("INVALID_PATH", "helper image path contains a noncanonical component");
    }
    components.push_back(component);
    start = end + 1;
  }
  if (components.empty()) throw BootstrapError("INVALID_PATH", "helper image path has no filename");
  return ParsedImagePath{
    device_target,
    std::move(components),
    L"\\\\?\\GLOBALROOT" + device_target + path.substr(2),
  };
}

ParsedMappedImagePath ParseMappedImagePath(const std::wstring& path) {
  constexpr wchar_t kPrefix[] = L"\\Device\\HarddiskVolume";
  constexpr size_t kPrefixLength = (sizeof(kPrefix) / sizeof(wchar_t)) - 1;
  if (path.rfind(kPrefix, 0) != 0) {
    throw BootstrapError("UNSUPPORTED_ROOT", "mapped native image is not on a canonical physical volume");
  }
  const size_t root_separator = path.find(L'\\', kPrefixLength);
  if (root_separator == std::wstring::npos || root_separator == kPrefixLength
      || !std::all_of(path.begin() + kPrefixLength, path.begin() + root_separator, [](wchar_t character) {
        return character >= L'0' && character <= L'9';
      })) {
    throw BootstrapError("UNSUPPORTED_ROOT", "mapped native image has a noncanonical physical-volume name");
  }
  std::vector<std::wstring> components;
  size_t start = root_separator + 1;
  while (start < path.size()) {
    size_t end = path.find(L'\\', start);
    if (end == std::wstring::npos) end = path.size();
    const std::wstring component = path.substr(start, end - start);
    if (!ClosedWindowsComponent(component)) {
      throw BootstrapError("INVALID_PATH", "mapped native image contains a noncanonical component");
    }
    components.push_back(component);
    start = end + 1;
  }
  if (components.empty()) throw BootstrapError("INVALID_PATH", "mapped native image has no filename");
  return ParsedMappedImagePath{path.substr(0, root_separator + 1), std::move(components)};
}

void ValidateOpenedComponent(HANDLE handle, const std::wstring& expected) {
  const DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (required == 0) throw BootstrapError("IO", WindowsFailure("measure normalized image component"));
  std::vector<wchar_t> buffer(static_cast<size_t>(required) + 1, L'\0');
  const DWORD copied = GetFinalPathNameByHandleW(
      handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (copied == 0 || copied >= buffer.size()) {
    throw BootstrapError("IO", WindowsFailure("query normalized image component"));
  }
  std::wstring opened(buffer.data(), copied);
  const size_t separator = opened.find_last_of(L"\\/");
  if (separator != std::wstring::npos) opened.erase(0, separator + 1);
  if (opened != expected) throw BootstrapError("ALIAS", "helper image path resolved through an alternate filesystem name");
}

UniqueHandle NtOpenAbsoluteDirectory(const std::wstring& native_path) {
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWSTR>(native_path.data());
  name.Length = static_cast<USHORT>(native_path.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, nullptr, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = ResolveNtCreateFile()(&handle,
      FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
      &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
      FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
  if (status < 0) throw BootstrapError("IO", NtFailure("open helper-image volume", status));
  return UniqueHandle(handle);
}

UniqueHandle NtOpenRelative(HANDLE parent, const std::wstring& component, ACCESS_MASK access, ULONG options,
    ULONG sharing) {
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWSTR>(component.data());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &name, 0, parent, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = ResolveNtCreateFile()(&handle, access, &attributes, &status_block, nullptr,
      FILE_ATTRIBUTE_NORMAL, sharing, FILE_OPEN, options, nullptr, 0);
  if (status < 0) throw BootstrapError("IO", NtFailure("open exact helper-image component", status));
  UniqueHandle result(handle);
  ValidateOpenedComponent(result.Get(), component);
  return result;
}

struct FileSnapshot {
  std::string identity;
  uint64_t size = 0;
  uint64_t links = 0;
  uint64_t modified = 0;
  uint64_t changed = 0;
  bool directory = false;
  bool reparse = false;
};

FileSnapshot InspectFile(HANDLE handle) {
  FILE_STANDARD_INFO standard{};
  FILE_BASIC_INFO basic{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))
      || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))
      || !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))
      || !GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id))) {
    throw BootstrapError("IO", WindowsFailure("inspect locked helper image"));
  }
  std::ostringstream identity;
  identity << std::hex << id.VolumeSerialNumber << ':' << std::setfill('0');
  for (uint8_t byte : id.FileId.Identifier) identity << std::setw(2) << static_cast<unsigned>(byte);
  return FileSnapshot{
    identity.str(),
    static_cast<uint64_t>(standard.EndOfFile.QuadPart),
    static_cast<uint64_t>(standard.NumberOfLinks),
    static_cast<uint64_t>(basic.LastWriteTime.QuadPart),
    static_cast<uint64_t>(basic.ChangeTime.QuadPart),
    standard.Directory != FALSE,
    (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0,
  };
}

bool StableFile(const FileSnapshot& left, const FileSnapshot& right) {
  return left.identity == right.identity && left.size == right.size && left.links == right.links
      && left.modified == right.modified && left.changed == right.changed
      && left.directory == right.directory && left.reparse == right.reparse;
}

std::vector<uint8_t> ReadLockedImage(HANDLE handle, uint64_t size) {
  if (size == 0 || size > kMaximumImageBytes) {
    throw BootstrapError("INVALID_IMAGE", "helper image size is outside the package bound");
  }
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) {
    throw BootstrapError("IO", WindowsFailure("seek locked helper image"));
  }
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD amount = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, 1024U * 1024U));
    DWORD read = 0;
    if (!ReadFile(handle, bytes.data() + offset, amount, &read, nullptr)) {
      throw BootstrapError("IO", WindowsFailure("read locked helper image"));
    }
    if (read == 0) throw BootstrapError("UNSTABLE_IMAGE", "locked helper image ended before its bound size");
    offset += read;
  }
  return bytes;
}

std::string Digest(const std::vector<uint8_t>& bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  const NTSTATUS opened = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (opened < 0) throw BootstrapError("CRYPTO", "BCryptOpenAlgorithmProvider(SHA-256) failed");
  std::array<uint8_t, 32> digest{};
  const NTSTATUS hashed = BCryptHash(algorithm, nullptr, 0,
      const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()),
      digest.data(), static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (hashed < 0) throw BootstrapError("CRYPTO", "BCryptHash(SHA-256) failed");
  std::ostringstream stream;
  stream << "sha256:" << std::hex << std::setfill('0');
  for (uint8_t byte : digest) stream << std::setw(2) << static_cast<unsigned>(byte);
  return stream.str();
}

void ProveMappedFileObject(HMODULE module, HANDLE locked_file) {
  UniqueHandle mapping(CreateFileMappingW(locked_file, nullptr, PAGE_READONLY, 0, 0, nullptr));
  if (mapping.Get() == nullptr || mapping.Get() == INVALID_HANDLE_VALUE) {
    throw BootstrapError("MODULE_IDENTITY", WindowsFailure("create locked-image data mapping"));
  }
  UniqueView view(MapViewOfFile(mapping.Get(), FILE_MAP_READ, 0, 0, 0));
  if (view.Get() == nullptr) {
    throw BootstrapError("MODULE_IDENTITY", WindowsFailure("map locked image as data"));
  }
  const NTSTATUS status = ResolveNtAreMappedFilesTheSame()(module, view.Get());
  if (status != 0) {
    throw BootstrapError("LOADED_IMAGE_MISMATCH",
        NtFailure("prove executed image and locked file are the same object", status));
  }
}

struct LockedImage {
  ParsedImagePath parsed;
  std::vector<UniqueHandle> directories;
  UniqueHandle file;
  FileSnapshot snapshot;
  std::string digest;
};

LockedImage OpenLockedImage(const std::string& path) {
  ParsedImagePath parsed = ParseImagePath(path);
  std::wstring native_root = parsed.device_target;
  if (native_root.back() != L'\\') native_root.push_back(L'\\');
  std::vector<UniqueHandle> directories;
  directories.push_back(NtOpenAbsoluteDirectory(native_root));
  for (size_t index = 0; index + 1 < parsed.components.size(); ++index) {
    UniqueHandle next = NtOpenRelative(directories.back().Get(), parsed.components[index],
        FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_SHARE_READ | FILE_SHARE_WRITE);
    const FileSnapshot directory = InspectFile(next.Get());
    if (!directory.directory || directory.reparse) {
      throw BootstrapError("REPARSE_POINT", "helper image ancestor is not a physical directory");
    }
    directories.push_back(std::move(next));
  }
  UniqueHandle file = NtOpenRelative(directories.back().Get(), parsed.components.back(),
      GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      FILE_SHARE_READ);
  const FileSnapshot before = InspectFile(file.Get());
  if (before.directory || before.reparse || before.links != 1 || before.size == 0 || before.size > kMaximumImageBytes) {
    throw BootstrapError("INVALID_IMAGE", "helper image is not one bounded unique physical file");
  }
  const std::vector<uint8_t> bytes = ReadLockedImage(file.Get(), before.size);
  const FileSnapshot after = InspectFile(file.Get());
  if (!StableFile(before, after) || bytes.size() != after.size) {
    throw BootstrapError("UNSTABLE_IMAGE", "helper image identity or bytes changed while locked");
  }
  return LockedImage{std::move(parsed), std::move(directories), std::move(file), after, Digest(bytes)};
}

std::wstring MappedModulePath(HMODULE module) {
  std::vector<wchar_t> path(1024, L'\0');
  while (true) {
    const DWORD copied = K32GetMappedFileNameW(
        GetCurrentProcess(), module, path.data(), static_cast<DWORD>(path.size()));
    if (copied == 0) throw BootstrapError("MODULE_IDENTITY", WindowsFailure("query mapped native-image path"));
    if (copied + 1 < path.size()) return std::wstring(path.data(), copied);
    if (path.size() >= 32768) throw BootstrapError("MODULE_IDENTITY", "mapped native-image path exceeds the package bound");
    path.resize(std::min<size_t>(path.size() * 2, 32768), L'\0');
  }
}

struct LockedMappedImage {
  std::wstring mapped_path;
  std::vector<UniqueHandle> directories;
  UniqueHandle file;
  FileSnapshot snapshot;
  std::string digest;
};

LockedMappedImage OpenLockedMappedImage(const std::wstring& mapped_path) {
  ParsedMappedImagePath parsed = ParseMappedImagePath(mapped_path);
  std::vector<UniqueHandle> directories;
  directories.push_back(NtOpenAbsoluteDirectory(parsed.device_root));
  for (size_t index = 0; index + 1 < parsed.components.size(); ++index) {
    UniqueHandle next = NtOpenRelative(directories.back().Get(), parsed.components[index],
        FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_SHARE_READ | FILE_SHARE_WRITE);
    const FileSnapshot directory = InspectFile(next.Get());
    if (!directory.directory || directory.reparse) {
      throw BootstrapError("REPARSE_POINT", "mapped native-image ancestor is not a physical directory");
    }
    directories.push_back(std::move(next));
  }
  UniqueHandle file = NtOpenRelative(directories.back().Get(), parsed.components.back(),
      GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      FILE_SHARE_READ);
  const FileSnapshot before = InspectFile(file.Get());
  if (before.directory || before.reparse || before.links != 1 || before.size == 0 || before.size > kMaximumImageBytes) {
    throw BootstrapError("INVALID_IMAGE", "mapped native image is not one bounded unique physical file");
  }
  const std::vector<uint8_t> bytes = ReadLockedImage(file.Get(), before.size);
  const FileSnapshot after = InspectFile(file.Get());
  if (!StableFile(before, after) || bytes.size() != after.size) {
    throw BootstrapError("UNSTABLE_IMAGE", "mapped native-image identity or bytes changed while locked");
  }
  return LockedMappedImage{mapped_path, std::move(directories), std::move(file), after, Digest(bytes)};
}

LockedMappedImage VerifyMappedModule(HMODULE module) {
  const std::wstring before = MappedModulePath(module);
  LockedMappedImage image = OpenLockedMappedImage(before);
  const std::wstring after = MappedModulePath(module);
  if (before != after || image.mapped_path != after) {
    throw BootstrapError("UNSTABLE_IMAGE", "mapped native-image name changed during identity proof");
  }
  ProveMappedFileObject(module, image.file.Get());
  return image;
}

struct ModuleRecord {
  HMODULE module = nullptr;
  HANDLE locked_file = INVALID_HANDLE_VALUE;
  std::string identity;
  std::string digest;
};

std::mutex& LoaderMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_map<HMODULE, ModuleRecord*>& LoadedModules() {
  static auto* records = new std::unordered_map<HMODULE, ModuleRecord*>();
  return *records;
}

using GetApiVersionFunction = int32_t (*)();
using InitializeAddonFunction = napi_value (*)(napi_env, napi_value);

struct LoadedModule {
  ModuleRecord* record;
  InitializeAddonFunction initialize;
};

LoadedModule LoadExactModule(LockedImage& image) {
  std::lock_guard<std::mutex> guard(LoaderMutex());
  HMODULE module = LoadLibraryExW(image.parsed.global_path.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (module == nullptr) throw BootstrapError("LOAD_FAILED", WindowsFailure("LoadLibraryExW locked helper image"));
  try {
    ProveMappedFileObject(module, image.file.Get());
    LockedMappedImage mapped = VerifyMappedModule(module);
    if (!StableFile(mapped.snapshot, image.snapshot) || mapped.digest != image.digest) {
      throw BootstrapError("LOADED_IMAGE_MISMATCH",
          "the executed helper image is not the locked and digested file object");
    }

    auto existing = LoadedModules().find(module);
    if (existing != LoadedModules().end()) {
      ModuleRecord* record = existing->second;
      if (record->identity != image.snapshot.identity || record->digest != image.digest) {
        throw BootstrapError("CACHED_IMAGE_MISMATCH", "loaded helper cache does not identify the locked image");
      }
      auto initialize = reinterpret_cast<InitializeAddonFunction>(
          GetProcAddress(record->module, "napi_register_module_v1"));
      if (initialize == nullptr) throw BootstrapError("INVALID_IMAGE", "loaded helper has no Node-API entry point");
      FreeLibrary(module);
      return LoadedModule{record, initialize};
    }

    auto get_api_version = reinterpret_cast<GetApiVersionFunction>(
        GetProcAddress(module, "node_api_module_get_api_version_v1"));
    auto initialize = reinterpret_cast<InitializeAddonFunction>(GetProcAddress(module, "napi_register_module_v1"));
    if (get_api_version == nullptr || initialize == nullptr || get_api_version() != NAPI_VERSION) {
      throw BootstrapError("INVALID_IMAGE", "helper image has an incompatible Node-API entry point");
    }
    auto record = std::make_unique<ModuleRecord>(ModuleRecord{
      module,
      INVALID_HANDLE_VALUE,
      image.snapshot.identity,
      image.digest,
    });
    ModuleRecord* record_pointer = record.get();
    const auto inserted = LoadedModules().emplace(module, record_pointer);
    if (!inserted.second) throw BootstrapError("MODULE_IDENTITY", "helper module registry changed unexpectedly");
    record_pointer->locked_file = image.file.Release();
    record.release();
    return LoadedModule{record_pointer, initialize};
  } catch (...) {
    FreeLibrary(module);
    throw;
  }
}

struct BootstrapImageRecord {
  HMODULE module;
  LockedMappedImage image;
};

BootstrapImageRecord& BootstrapImage() {
  static BootstrapImageRecord* record = [] {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&kBootstrapModuleAnchor), &module)) {
      throw BootstrapError("MODULE_IDENTITY", WindowsFailure("pin trusted-bootstrap module"));
    }
    LockedMappedImage image = VerifyMappedModule(module);
    return new BootstrapImageRecord{module, std::move(image)};
  }();
  return *record;
}

napi_value CreateString(napi_env env, const std::string& value) {
  napi_value result;
  CheckNapi(env, napi_create_string_utf8(env, value.data(), value.size(), &result), "create string");
  return result;
}

void SetProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  CheckNapi(env, napi_set_named_property(env, object, name, value), "set property");
}

napi_value LoadVerified(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() -> napi_value {
    size_t argc = 2;
    napi_value argv[2]{};
    CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "read load arguments");
    if (argc < 1) throw BootstrapError("INVALID_ARGUMENT", "helper image path is required");
    LockedImage image = OpenLockedImage(Utf8(env, argv[0], "helper image path"));

    if (argc >= 2) {
      napi_valuetype hook_type;
      CheckNapi(env, napi_typeof(env, argv[1], &hook_type), "inspect before-load hook");
      if (hook_type != napi_undefined && hook_type != napi_function) {
        throw BootstrapError("INVALID_ARGUMENT", "before-load hook must be a function when supplied");
      }
      if (hook_type == napi_function) {
        napi_value global;
        napi_value ignored;
        CheckNapi(env, napi_get_global(env, &global), "get callback receiver");
        const napi_status called = napi_call_function(env, global, argv[1], 0, nullptr, &ignored);
        if (called == napi_pending_exception) return nullptr;
        CheckNapi(env, called, "invoke before-load hook");
      }
    }

    LoadedModule loaded = LoadExactModule(image);
    napi_value exports;
    CheckNapi(env, napi_create_object(env, &exports), "create helper exports");
    napi_value binding = loaded.initialize(env, exports);
    bool pending = false;
    CheckNapi(env, napi_is_exception_pending(env, &pending), "inspect helper initialization");
    if (pending) return nullptr;
    if (binding == nullptr) throw BootstrapError("INVALID_IMAGE", "helper Node-API entry point returned no exports");

    napi_value result;
    CheckNapi(env, napi_create_object(env, &result), "create verified-load result");
    SetProperty(env, result, "binaryDigest", CreateString(env, loaded.record->digest));
    SetProperty(env, result, "binding", binding);
    SetProperty(env, result, "fileIdentity", CreateString(env, loaded.record->identity));
    return result;
  });
}

}  // namespace

NAPI_MODULE_INIT() {
  return Guard(env, [&]() {
    BootstrapImageRecord& bootstrap_image = BootstrapImage();
    napi_value abi_version;
    CheckNapi(env, napi_create_uint32(env, kBootstrapAbiVersion, &abi_version), "create bootstrap ABI version");
    SetProperty(env, exports, "abiVersion", abi_version);
    SetProperty(env, exports, "imageDigest", CreateString(env, bootstrap_image.image.digest));
    SetProperty(env, exports, "loaderVersion", CreateString(env, kBootstrapVersion));
    napi_value load_verified;
    CheckNapi(env, napi_create_function(
        env, "loadVerified", NAPI_AUTO_LENGTH, LoadVerified, nullptr, &load_verified), "create verified loader");
    SetProperty(env, exports, "loadVerified", load_verified);
    return exports;
  });
}
