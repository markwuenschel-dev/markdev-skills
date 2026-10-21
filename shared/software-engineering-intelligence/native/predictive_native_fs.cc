#define NAPI_VERSION 8
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <winternl.h>
#else
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <node_api.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cwctype>
#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifndef PREDICTIVE_SOURCE_SHA256_HEX
#error PREDICTIVE_SOURCE_SHA256_HEX must bind the compiled helper to its reviewed source
#endif
#define PREDICTIVE_STRINGIFY_INNER(value) #value
#define PREDICTIVE_STRINGIFY(value) PREDICTIVE_STRINGIFY_INNER(value)

namespace {

constexpr uint32_t kAbiVersion = 1;
constexpr const char* kSourceDigest = "sha256:" PREDICTIVE_STRINGIFY(PREDICTIVE_SOURCE_SHA256_HEX);
constexpr size_t kMaximumFileBytes = 16U * 1024U * 1024U;
constexpr size_t kMaximumComponents = 64;
// The legacy list operation remains available to the artifact store, but it is
// no longer allowed to materialize an unbounded native vector. Inspection uses
// the smaller caller-supplied bound exposed by listBounded.
constexpr size_t kMaximumDirectoryEntries = 4096;

class NativeError final : public std::runtime_error {
 public:
  NativeError(std::string reason, std::string message)
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
  throw NativeError("NAPI", detail);
}

napi_value ThrowNative(napi_env env, const NativeError& error) {
  napi_value message;
  napi_value js_error;
  napi_value code;
  napi_value reason;
  napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &js_error);
  napi_create_string_utf8(env, "FAIL-PREDICTIVE-NATIVE-FS", NAPI_AUTO_LENGTH, &code);
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
  } catch (const NativeError& error) {
    return ThrowNative(env, error);
  } catch (const std::exception& error) {
    return ThrowNative(env, NativeError("INTERNAL", error.what()));
  } catch (...) {
    return ThrowNative(env, NativeError("INTERNAL", "unknown native filesystem failure"));
  }
}

// Compact, dependency-free SHA-256 used to bind bytes to the same opened handle.
class Sha256 final {
 public:
  Sha256() { Reset(); }

  void Update(const uint8_t* input, size_t length) {
    for (size_t index = 0; index < length; ++index) {
      data_[data_length_++] = input[index];
      if (data_length_ == 64) {
        Transform();
        bit_length_ += 512;
        data_length_ = 0;
      }
    }
  }

  std::array<uint8_t, 32> Final() {
    size_t index = data_length_;
    data_[index++] = 0x80;
    if (index > 56) {
      while (index < 64) data_[index++] = 0;
      Transform();
      index = 0;
    }
    while (index < 56) data_[index++] = 0;
    bit_length_ += static_cast<uint64_t>(data_length_) * 8;
    for (int shift = 56; shift >= 0; shift -= 8) {
      data_[index++] = static_cast<uint8_t>((bit_length_ >> shift) & 0xffU);
    }
    Transform();

    std::array<uint8_t, 32> digest{};
    for (size_t word = 0; word < 8; ++word) {
      digest[word * 4] = static_cast<uint8_t>((state_[word] >> 24) & 0xffU);
      digest[word * 4 + 1] = static_cast<uint8_t>((state_[word] >> 16) & 0xffU);
      digest[word * 4 + 2] = static_cast<uint8_t>((state_[word] >> 8) & 0xffU);
      digest[word * 4 + 3] = static_cast<uint8_t>(state_[word] & 0xffU);
    }
    return digest;
  }

 private:
  static uint32_t RotateRight(uint32_t value, uint32_t count) {
    return (value >> count) | (value << (32U - count));
  }

  void Reset() {
    data_.fill(0);
    data_length_ = 0;
    bit_length_ = 0;
    state_ = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
              0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  }

  void Transform() {
    static constexpr std::array<uint32_t, 64> constants = {
      0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
      0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
      0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
      0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
      0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
      0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
      0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
      0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
    };
    std::array<uint32_t, 64> words{};
    for (size_t index = 0; index < 16; ++index) {
      words[index] = (static_cast<uint32_t>(data_[index * 4]) << 24)
          | (static_cast<uint32_t>(data_[index * 4 + 1]) << 16)
          | (static_cast<uint32_t>(data_[index * 4 + 2]) << 8)
          | static_cast<uint32_t>(data_[index * 4 + 3]);
    }
    for (size_t index = 16; index < 64; ++index) {
      const uint32_t s0 = RotateRight(words[index - 15], 7) ^ RotateRight(words[index - 15], 18) ^ (words[index - 15] >> 3);
      const uint32_t s1 = RotateRight(words[index - 2], 17) ^ RotateRight(words[index - 2], 19) ^ (words[index - 2] >> 10);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    uint32_t a = state_[0];
    uint32_t b = state_[1];
    uint32_t c = state_[2];
    uint32_t d = state_[3];
    uint32_t e = state_[4];
    uint32_t f = state_[5];
    uint32_t g = state_[6];
    uint32_t h = state_[7];
    for (size_t index = 0; index < 64; ++index) {
      const uint32_t s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
      const uint32_t choice = (e & f) ^ ((~e) & g);
      const uint32_t first = h + s1 + choice + constants[index] + words[index];
      const uint32_t s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t second = s0 + majority;
      h = g; g = f; f = e; e = d + first; d = c; c = b; b = a; a = first + second;
    }
    state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
    state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
  }

  std::array<uint8_t, 64> data_{};
  size_t data_length_ = 0;
  uint64_t bit_length_ = 0;
  std::array<uint32_t, 8> state_{};
};

std::string Digest(const uint8_t* bytes, size_t length) {
  Sha256 hasher;
  hasher.Update(bytes, length);
  const auto digest = hasher.Final();
  std::ostringstream stream;
  stream << "sha256:" << std::hex << std::setfill('0');
  for (uint8_t byte : digest) stream << std::setw(2) << static_cast<unsigned>(byte);
  return stream.str();
}

bool IsExpectedDigest(const std::string& value) {
  if (value.size() != 71 || value.rfind("sha256:", 0) != 0) return false;
  return std::all_of(value.begin() + 7, value.end(), [](unsigned char character) {
    return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
  });
}

std::string Utf8(napi_env env, napi_value value, const char* label) {
  napi_valuetype type;
  CheckNapi(env, napi_typeof(env, value, &type), "inspect string");
  if (type != napi_string) throw NativeError("INVALID_ARGUMENT", std::string(label) + " must be a string");
  size_t length = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "measure string");
  std::string result(length + 1, '\0');
  size_t copied = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, result.data(), length + 1, &copied), "read string");
  result.resize(copied);
  if (result.find('\0') != std::string::npos) throw NativeError("INVALID_COMPONENT", std::string(label) + " contains NUL");
  return result;
}

bool ClosedComponent(const std::string& component) {
  if (component.empty() || component.size() > 255 || component == "." || component == "..") return false;
  if (component.find('\0') != std::string::npos || component.find('/') != std::string::npos
      || component.find('\\') != std::string::npos) return false;
#ifdef _WIN32
  if (component.find(':') != std::string::npos || component.back() == '.' || component.back() == ' ') return false;
  std::string basename = component.substr(0, component.find('.'));
  std::transform(basename.begin(), basename.end(), basename.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  if (basename == "CON" || basename == "PRN" || basename == "AUX" || basename == "NUL"
      || (basename.size() == 4 && (basename.rfind("COM", 0) == 0 || basename.rfind("LPT", 0) == 0)
          && basename[3] >= '1' && basename[3] <= '9')) return false;
#endif
  return true;
}

std::vector<std::string> Components(napi_env env, napi_value value) {
  bool is_array = false;
  CheckNapi(env, napi_is_array(env, value, &is_array), "inspect components");
  if (!is_array) throw NativeError("INVALID_COMPONENT", "path components must be an array");
  uint32_t length = 0;
  CheckNapi(env, napi_get_array_length(env, value, &length), "measure components");
  if (length == 0 || length > kMaximumComponents) throw NativeError("INVALID_COMPONENT", "path component count is outside the closed bound");
  std::vector<std::string> result;
  result.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    CheckNapi(env, napi_get_element(env, value, index, &item), "read component");
    std::string component = Utf8(env, item, "path component");
    if (!ClosedComponent(component)) throw NativeError("INVALID_COMPONENT", "path component is not closed");
    result.push_back(std::move(component));
  }
  return result;
}

struct Snapshot {
  std::string identity;
  uint64_t size = 0;
  uint64_t links = 0;
  uint64_t modified_marker = 0;
  uint64_t changed_marker = 0;
  int64_t modified_ns = 0;
  int64_t changed_ns = 0;
  bool directory = false;
  bool regular = false;
  bool reparse = false;
};

#ifdef _WIN32

using NativeHandle = HANDLE;
const NativeHandle kInvalidHandle = INVALID_HANDLE_VALUE;

#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002
#endif
#ifndef FILE_OPEN_IF
#define FILE_OPEN_IF 0x00000003
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_WRITE_THROUGH
#define FILE_WRITE_THROUGH 0x00000002
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
#ifndef STATUS_OBJECT_NAME_NOT_FOUND
#define STATUS_OBJECT_NAME_NOT_FOUND static_cast<NTSTATUS>(0xC0000034L)
#endif
#ifndef STATUS_OBJECT_PATH_NOT_FOUND
#define STATUS_OBJECT_PATH_NOT_FOUND static_cast<NTSTATUS>(0xC000003AL)
#endif
#ifndef STATUS_OBJECT_NAME_COLLISION
#define STATUS_OBJECT_NAME_COLLISION static_cast<NTSTATUS>(0xC0000035L)
#endif
#ifndef STATUS_ACCESS_DENIED
#define STATUS_ACCESS_DENIED static_cast<NTSTATUS>(0xC0000022L)
#endif

using NtCreateFileFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileFunction = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

NtCreateFileFunction ResolveNtCreateFile() {
  static NtCreateFileFunction function = [] {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    return module == nullptr ? nullptr : reinterpret_cast<NtCreateFileFunction>(GetProcAddress(module, "NtCreateFile"));
  }();
  if (function == nullptr) throw NativeError("UNSUPPORTED", "NtCreateFile is unavailable");
  return function;
}

NtSetInformationFileFunction ResolveNtSetInformationFile() {
  static NtSetInformationFileFunction function = [] {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    return module == nullptr ? nullptr
        : reinterpret_cast<NtSetInformationFileFunction>(GetProcAddress(module, "NtSetInformationFile"));
  }();
  if (function == nullptr) throw NativeError("UNSUPPORTED", "NtSetInformationFile is unavailable");
  return function;
}

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) throw NativeError("INVALID_COMPONENT", "path component is not valid UTF-8");
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length) != length) {
    throw NativeError("INVALID_COMPONENT", "path component conversion failed");
  }
  return result;
}

std::string WindowsFailure(const char* operation, DWORD code = GetLastError()) {
  std::ostringstream stream;
  stream << operation << " failed (win32=" << code << ")";
  return stream.str();
}

std::string NtFailure(const char* operation, NTSTATUS status) {
  std::ostringstream stream;
  stream << operation << " failed (ntstatus=0x" << std::hex << static_cast<uint32_t>(status) << ")";
  return stream.str();
}

void CloseHandleSafe(NativeHandle handle) {
  if (handle != nullptr && handle != kInvalidHandle) CloseHandle(handle);
}

int64_t WindowsFileTimeNanoseconds(LONGLONG ticks) {
  constexpr LONGLONG kUnixEpochInWindowsTicks = 116444736000000000LL;
  if (ticks <= kUnixEpochInWindowsTicks) return 0;
  const uint64_t unix_ticks = static_cast<uint64_t>(ticks - kUnixEpochInWindowsTicks);
  if (unix_ticks > static_cast<uint64_t>(std::numeric_limits<int64_t>::max() / 100)) {
    return std::numeric_limits<int64_t>::max();
  }
  return static_cast<int64_t>(unix_ticks * 100);
}

Snapshot InspectHandle(NativeHandle handle) {
  FILE_STANDARD_INFO standard{};
  FILE_BASIC_INFO basic{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))
      || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))
      || !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))
      || !GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id))) {
    throw NativeError("IO", WindowsFailure("GetFileInformationByHandleEx"));
  }
  std::ostringstream identity;
  identity << std::hex << id.VolumeSerialNumber << ':' << std::setfill('0');
  for (uint8_t byte : id.FileId.Identifier) identity << std::setw(2) << static_cast<unsigned>(byte);
  Snapshot snapshot;
  snapshot.identity = identity.str();
  snapshot.size = static_cast<uint64_t>(standard.EndOfFile.QuadPart);
  snapshot.links = static_cast<uint64_t>(standard.NumberOfLinks);
  snapshot.modified_marker = static_cast<uint64_t>(basic.LastWriteTime.QuadPart);
  snapshot.changed_marker = static_cast<uint64_t>(basic.ChangeTime.QuadPart);
  snapshot.modified_ns = WindowsFileTimeNanoseconds(basic.LastWriteTime.QuadPart);
  snapshot.changed_ns = WindowsFileTimeNanoseconds(basic.ChangeTime.QuadPart);
  snapshot.directory = standard.Directory != FALSE;
  snapshot.reparse = (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  snapshot.regular = !snapshot.directory && !snapshot.reparse;
  return snapshot;
}

void ValidateDirectory(NativeHandle handle) {
  Snapshot snapshot = InspectHandle(handle);
  if (!snapshot.directory || snapshot.reparse) throw NativeError("REPARSE_POINT", "directory handle is not a physical no-reparse directory");
}

void ValidateOpenedComponent(NativeHandle handle, const std::wstring& expected, bool case_insensitive) {
  const DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, flags);
  if (required == 0) throw NativeError("IO", WindowsFailure("measure normalized opened component name"));
  std::vector<wchar_t> storage(static_cast<size_t>(required) + 1, L'\0');
  const DWORD copied = GetFinalPathNameByHandleW(handle, storage.data(), static_cast<DWORD>(storage.size()), flags);
  if (copied == 0 || copied >= storage.size()) {
    throw NativeError("IO", WindowsFailure("query normalized opened component name"));
  }
  std::wstring opened(storage.data(), copied);
  const size_t separator = opened.find_last_of(L"\\/");
  if (separator != std::wstring::npos) opened.erase(0, separator + 1);
  const bool matches = case_insensitive
      ? CompareStringOrdinal(opened.data(), static_cast<int>(opened.size()), expected.data(),
          static_cast<int>(expected.size()), TRUE) == CSTR_EQUAL
      : opened == expected;
  if (!matches) throw NativeError("ALIAS", "opened component resolved through an alternate filesystem name");
}

NativeHandle NtOpenRelative(NativeHandle parent, const std::wstring& name, ACCESS_MASK access,
    ULONG disposition, ULONG options, ULONG share_access, bool allow_missing,
    bool* absent = nullptr, bool case_insensitive = false) {
  if (name.empty() || name.size() > (std::numeric_limits<USHORT>::max() / sizeof(wchar_t))) {
    throw NativeError("INVALID_COMPONENT", "native component length is invalid");
  }
  UNICODE_STRING native_name{};
  native_name.Buffer = const_cast<PWSTR>(name.data());
  native_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  native_name.MaximumLength = native_name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &native_name, case_insensitive ? OBJ_CASE_INSENSITIVE : 0, parent, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE handle = kInvalidHandle;
  NTSTATUS status = ResolveNtCreateFile()(&handle, access, &attributes, &status_block, nullptr,
      FILE_ATTRIBUTE_NORMAL, share_access, disposition, options, nullptr, 0);
  if (status < 0) {
    if (allow_missing && (status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND)) {
      if (absent != nullptr) *absent = true;
      return kInvalidHandle;
    }
    if (status == STATUS_OBJECT_NAME_COLLISION) throw NativeError("EXISTS", "exclusive publication target already exists");
    if (status == STATUS_ACCESS_DENIED) throw NativeError("ACCESS_DENIED", NtFailure("NtCreateFile", status));
    throw NativeError("IO", NtFailure("NtCreateFile", status));
  }
  try {
    ValidateOpenedComponent(handle, name, false);
  } catch (...) {
    CloseHandleSafe(handle);
    throw;
  }
  if (absent != nullptr) *absent = false;
  return handle;
}

NativeHandle NtOpenAbsoluteDirectory(const std::wstring& native_path) {
  if (native_path.empty() || native_path.size() > (std::numeric_limits<USHORT>::max() / sizeof(wchar_t))) {
    throw NativeError("UNSUPPORTED_ROOT", "native volume path is invalid");
  }
  UNICODE_STRING native_name{};
  native_name.Buffer = const_cast<PWSTR>(native_path.data());
  native_name.Length = static_cast<USHORT>(native_path.size() * sizeof(wchar_t));
  native_name.MaximumLength = native_name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &native_name, OBJ_CASE_INSENSITIVE, nullptr, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE handle = kInvalidHandle;
  const NTSTATUS status = ResolveNtCreateFile()(&handle,
      FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
      &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      nullptr, 0);
  if (status < 0) throw NativeError("IO", NtFailure("open validated native volume root", status));
  try {
    ValidateDirectory(handle);
  } catch (...) {
    CloseHandleSafe(handle);
    throw;
  }
  return handle;
}

NativeHandle OpenChildDirectory(NativeHandle parent, const std::string& component, bool create, bool allow_missing,
    bool* absent = nullptr, bool writable = true, bool case_insensitive = false) {
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE;
  if (writable) access |= FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
  NativeHandle handle = NtOpenRelative(parent, Wide(component),
      access,
      create ? FILE_OPEN_IF : FILE_OPEN,
      FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      allow_missing, absent, case_insensitive);
  if (handle == kInvalidHandle) return handle;
  try {
    ValidateDirectory(handle);
  } catch (...) {
    CloseHandleSafe(handle);
    throw;
  }
  return handle;
}

NativeHandle OpenAbsoluteRootInternal(const std::string& utf8_path, bool create_missing, bool* root_absent = nullptr) {
  std::wstring path = Wide(utf8_path);
  if (path.find(L'/') != std::wstring::npos || path.size() < 3
      || path[0] < L'A' || path[0] > L'Z' || path[1] != L':' || path[2] != L'\\'
      || (path.size() > 3 && path.back() == L'\\')) {
    throw NativeError("UNSUPPORTED_ROOT", "Windows predictive state root must use one canonical uppercase-drive DOS absolute spelling");
  }
  std::wstring drive_name;
  drive_name.push_back(static_cast<wchar_t>(towupper(path[0])));
  drive_name.push_back(L':');
  const std::wstring drive_root = drive_name + L"\\";
  if (GetDriveTypeW(drive_root.c_str()) != DRIVE_FIXED) {
    throw NativeError("UNSUPPORTED_ROOT", "Windows predictive state root must be on a local fixed drive");
  }
  std::array<wchar_t, 32768> device_target{};
  if (QueryDosDeviceW(drive_name.c_str(), device_target.data(), static_cast<DWORD>(device_target.size())) == 0) {
    throw NativeError("IO", WindowsFailure("resolve state-root drive"));
  }
  const std::wstring drive_target(device_target.data());
  constexpr wchar_t kPhysicalVolumePrefix[] = L"\\Device\\HarddiskVolume";
  constexpr size_t kPhysicalVolumePrefixLength = (sizeof(kPhysicalVolumePrefix) / sizeof(wchar_t)) - 1;
  const bool exact_physical_volume = drive_target.size() > kPhysicalVolumePrefixLength
      && CompareStringOrdinal(drive_target.data(), static_cast<int>(kPhysicalVolumePrefixLength),
          kPhysicalVolumePrefix, static_cast<int>(kPhysicalVolumePrefixLength), TRUE) == CSTR_EQUAL
      && std::all_of(drive_target.begin() + kPhysicalVolumePrefixLength, drive_target.end(), [](wchar_t character) {
        return character >= L'0' && character <= L'9';
      });
  if (!exact_physical_volume) {
    throw NativeError("UNSUPPORTED_ROOT", "Windows predictive state root drive is not a physical local volume");
  }
  std::wstring native_volume_root = drive_target;
  if (native_volume_root.back() != L'\\') native_volume_root.push_back(L'\\');
  NativeHandle current = NtOpenAbsoluteDirectory(native_volume_root);
  try {
    ValidateDirectory(current);
    bool current_writable = false;
    size_t start = 3;
    while (start < path.size()) {
      size_t end = path.find(L'\\', start);
      if (end == std::wstring::npos) end = path.size();
      if (end == start) throw NativeError("INVALID_COMPONENT", "state root contains an empty component");
      std::wstring wide_component = path.substr(start, end - start);
      if (wide_component == L"." || wide_component == L"..") throw NativeError("INVALID_COMPONENT", "state root contains a relative component");
      int utf8_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_component.data(), static_cast<int>(wide_component.size()), nullptr, 0, nullptr, nullptr);
      if (utf8_length <= 0) throw NativeError("INVALID_COMPONENT", "state root component conversion failed");
      std::string component(static_cast<size_t>(utf8_length), '\0');
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_component.data(), static_cast<int>(wide_component.size()), component.data(), utf8_length, nullptr, nullptr);
      if (!ClosedComponent(component)) throw NativeError("INVALID_COMPONENT", "state root contains an invalid component");
      NativeHandle next = kInvalidHandle;
      bool absent = false;
      bool next_writable = true;
      try {
        next = OpenChildDirectory(current, component, false, true, &absent, true, true);
      } catch (const NativeError& error) {
        if (error.reason() != "ACCESS_DENIED") {
          throw NativeError(error.reason(), "state root component '" + component + "': " + error.what());
        }
        next_writable = false;
        next = OpenChildDirectory(current, component, false, true, &absent, false, true);
      }
      if (absent) {
        if (!create_missing) {
          if (root_absent != nullptr) *root_absent = true;
          CloseHandleSafe(current);
          return kInvalidHandle;
        }
        if (!current_writable) {
          throw NativeError("ACCESS_DENIED", "nearest existing state-root ancestor cannot create the missing component '" + component + "'");
        }
        next = OpenChildDirectory(current, component, true, false, nullptr, true, true);
        next_writable = true;
      }
      CloseHandleSafe(current);
      current = next;
      current_writable = next_writable;
      start = end + 1;
    }
    if (root_absent != nullptr) *root_absent = false;
    return current;
  } catch (...) {
    CloseHandleSafe(current);
    throw;
  }
}

NativeHandle OpenAbsoluteRoot(const std::string& utf8_path) {
  return OpenAbsoluteRootInternal(utf8_path, true);
}

NativeHandle OpenAbsoluteRootReadOnly(const std::string& utf8_path, bool* absent = nullptr) {
  return OpenAbsoluteRootInternal(utf8_path, false, absent);
}

NativeHandle DuplicateDirectory(NativeHandle handle) {
  HANDLE duplicate = kInvalidHandle;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    throw NativeError("IO", WindowsFailure("DuplicateHandle"));
  }
  return duplicate;
}

void SeekStart(NativeHandle handle) {
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) throw NativeError("IO", WindowsFailure("SetFilePointerEx"));
}

std::vector<uint8_t> ReadExactHandle(NativeHandle handle, size_t length) {
  std::vector<uint8_t> bytes(length);
  SeekStart(handle);
  size_t offset = 0;
  while (offset < length) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(length - offset, 1024U * 1024U));
    DWORD read = 0;
    if (!ReadFile(handle, bytes.data() + offset, chunk, &read, nullptr)) throw NativeError("IO", WindowsFailure("ReadFile"));
    if (read == 0) throw NativeError("UNSTABLE", "opened file ended before its bound length");
    offset += read;
  }
  return bytes;
}

void WriteExactHandle(NativeHandle handle, const uint8_t* bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(length - offset, 1024U * 1024U));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, chunk, &written, nullptr)) throw NativeError("IO", WindowsFailure("WriteFile"));
    if (written == 0) throw NativeError("IO", "WriteFile made no progress");
    offset += written;
  }
  if (!FlushFileBuffers(handle)) throw NativeError("IO", WindowsFailure("FlushFileBuffers"));
}

void DeleteOpenedHandle(NativeHandle handle) {
#ifdef FILE_DISPOSITION_FLAG_DELETE
  FILE_DISPOSITION_INFO_EX disposition{};
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
  if (SetFileInformationByHandle(handle, FileDispositionInfoEx, &disposition, sizeof(disposition))) return;
#endif
  FILE_DISPOSITION_INFO fallback{};
  fallback.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &fallback, sizeof(fallback))) {
    throw NativeError("IO", WindowsFailure("delete opened file"));
  }
}

std::wstring StagingName() {
  static std::atomic<uint64_t> sequence{0};
  std::wostringstream stream;
  stream << L".sei-predictive-stage-" << GetCurrentProcessId() << L'-' << sequence.fetch_add(1, std::memory_order_relaxed);
  return stream.str();
}

NativeHandle CreateStagedFile(NativeHandle staging_parent) {
  for (size_t attempt = 0; attempt < 128; ++attempt) {
    try {
      return NtOpenRelative(staging_parent, StagingName(),
          GENERIC_READ | GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_CREATE,
          FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_WRITE_THROUGH,
          FILE_SHARE_READ, false);
    } catch (const NativeError& error) {
      if (error.reason() != "EXISTS") throw;
    }
  }
  throw NativeError("EXISTS", "could not reserve a bounded unique publication staging name");
}

void RenameOpenedHandle(NativeHandle handle, NativeHandle parent, const std::wstring& name) {
  const size_t name_bytes = name.size() * sizeof(wchar_t);
  const size_t information_size = offsetof(FILE_RENAME_INFO, FileName) + name_bytes;
  std::vector<uint8_t> storage(information_size, 0);
  auto* information = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  information->ReplaceIfExists = FALSE;
  information->RootDirectory = parent;
  information->FileNameLength = static_cast<DWORD>(name_bytes);
  std::memcpy(information->FileName, name.data(), name_bytes);
  IO_STATUS_BLOCK status_block{};
  const NTSTATUS status = ResolveNtSetInformationFile()(handle, &status_block, information,
      static_cast<ULONG>(information_size), static_cast<FILE_INFORMATION_CLASS>(10));  // FileRenameInformation
  if (status < 0) {
    if (status == STATUS_OBJECT_NAME_COLLISION) {
      throw NativeError("EXISTS", "exclusive publication target already exists");
    }
    throw NativeError("IO", NtFailure("handle-relative publication rename", status));
  }
  ValidateOpenedComponent(handle, name, false);
}

#else

using NativeHandle = int;
constexpr NativeHandle kInvalidHandle = -1;

std::string PosixFailure(const char* operation, int code = errno) {
  std::ostringstream stream;
  stream << operation << " failed (errno=" << code << ": " << std::strerror(code) << ')';
  return stream.str();
}

void CloseHandleSafe(NativeHandle handle) {
  if (handle >= 0) close(handle);
}

int64_t ModifiedNanoseconds(const struct stat& value) {
#if defined(__APPLE__)
  return static_cast<int64_t>(value.st_mtimespec.tv_sec) * 1000000000LL + value.st_mtimespec.tv_nsec;
#else
  return static_cast<int64_t>(value.st_mtim.tv_sec) * 1000000000LL + value.st_mtim.tv_nsec;
#endif
}

int64_t ChangedNanoseconds(const struct stat& value) {
#if defined(__APPLE__)
  return static_cast<int64_t>(value.st_ctimespec.tv_sec) * 1000000000LL + value.st_ctimespec.tv_nsec;
#else
  return static_cast<int64_t>(value.st_ctim.tv_sec) * 1000000000LL + value.st_ctim.tv_nsec;
#endif
}

Snapshot InspectHandle(NativeHandle handle) {
  struct stat value{};
  if (fstat(handle, &value) != 0) throw NativeError("IO", PosixFailure("fstat"));
  Snapshot snapshot;
  snapshot.identity = std::to_string(static_cast<uint64_t>(value.st_dev)) + ':' + std::to_string(static_cast<uint64_t>(value.st_ino));
  snapshot.size = static_cast<uint64_t>(value.st_size);
  snapshot.links = static_cast<uint64_t>(value.st_nlink);
  snapshot.modified_ns = ModifiedNanoseconds(value);
  snapshot.changed_ns = ChangedNanoseconds(value);
  snapshot.modified_marker = static_cast<uint64_t>(snapshot.modified_ns);
  snapshot.changed_marker = static_cast<uint64_t>(snapshot.changed_ns);
  snapshot.directory = S_ISDIR(value.st_mode);
  snapshot.regular = S_ISREG(value.st_mode);
  snapshot.reparse = S_ISLNK(value.st_mode);
  return snapshot;
}

void ValidateDirectory(NativeHandle handle) {
  Snapshot snapshot = InspectHandle(handle);
  if (!snapshot.directory || snapshot.reparse) throw NativeError("REPARSE_POINT", "directory handle is not a physical no-symlink directory");
}

NativeHandle OpenAbsoluteRootInternal(const std::string& path, bool create_missing, bool* root_absent = nullptr) {
  if (path.empty() || path.front() != '/') throw NativeError("UNSUPPORTED_ROOT", "POSIX predictive state root must be absolute");
  NativeHandle current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) throw NativeError("IO", PosixFailure("open root directory"));
  try {
    size_t start = 1;
    while (start < path.size()) {
      size_t end = path.find('/', start);
      if (end == std::string::npos) end = path.size();
      std::string component = path.substr(start, end - start);
      if (!ClosedComponent(component)) throw NativeError("INVALID_COMPONENT", "state root contains an invalid component");
      NativeHandle next = openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0 && errno == ENOENT && create_missing) {
        if (mkdirat(current, component.c_str(), 0700) != 0 && errno != EEXIST) {
          throw NativeError("IO", PosixFailure("mkdirat state root component"));
        }
        next = openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      }
      if (next < 0 && errno == ENOENT && !create_missing) {
        if (root_absent != nullptr) *root_absent = true;
        CloseHandleSafe(current);
        return kInvalidHandle;
      }
      if (next < 0) throw NativeError(errno == ELOOP ? "REPARSE_POINT" : "IO", PosixFailure("openat state root component"));
      ValidateDirectory(next);
      CloseHandleSafe(current);
      current = next;
      start = end + 1;
    }
    if (root_absent != nullptr) *root_absent = false;
    return current;
  } catch (...) {
    CloseHandleSafe(current);
    throw;
  }
}

NativeHandle OpenAbsoluteRoot(const std::string& path) {
  return OpenAbsoluteRootInternal(path, true);
}

NativeHandle OpenAbsoluteRootReadOnly(const std::string& path, bool* absent = nullptr) {
  return OpenAbsoluteRootInternal(path, false, absent);
}

NativeHandle OpenChildDirectory(NativeHandle parent, const std::string& component, bool create, bool allow_missing,
    bool* absent = nullptr, bool writable = true) {
  (void)writable;
  if (create && mkdirat(parent, component.c_str(), 0700) != 0 && errno != EEXIST) {
    throw NativeError("IO", PosixFailure("mkdirat"));
  }
  NativeHandle handle = openat(parent, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (handle < 0) {
    if (allow_missing && errno == ENOENT) {
      if (absent != nullptr) *absent = true;
      return kInvalidHandle;
    }
    throw NativeError(errno == ELOOP ? "REPARSE_POINT" : "IO", PosixFailure("openat directory"));
  }
  if (absent != nullptr) *absent = false;
  try {
    ValidateDirectory(handle);
  } catch (...) {
    CloseHandleSafe(handle);
    throw;
  }
  return handle;
}

NativeHandle DuplicateDirectory(NativeHandle handle) {
  NativeHandle duplicate = fcntl(handle, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) throw NativeError("IO", PosixFailure("duplicate directory descriptor"));
  return duplicate;
}

std::vector<uint8_t> ReadExactHandle(NativeHandle handle, size_t length) {
  std::vector<uint8_t> bytes(length);
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = pread(handle, bytes.data() + offset, length - offset, static_cast<off_t>(offset));
    if (result < 0) throw NativeError("IO", PosixFailure("pread"));
    if (result == 0) throw NativeError("UNSTABLE", "opened file ended before its bound length");
    offset += static_cast<size_t>(result);
  }
  return bytes;
}

void WriteExactHandle(NativeHandle handle, const uint8_t* bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = pwrite(handle, bytes + offset, length - offset, static_cast<off_t>(offset));
    if (result < 0) throw NativeError("IO", PosixFailure("pwrite"));
    if (result == 0) throw NativeError("IO", "pwrite made no progress");
    offset += static_cast<size_t>(result);
  }
  if (fsync(handle) != 0) throw NativeError("IO", PosixFailure("fsync"));
}

#endif

bool StableFile(const Snapshot& before, const Snapshot& after) {
  return before.identity == after.identity && before.size == after.size && before.links == after.links
      && before.modified_marker == after.modified_marker && before.changed_marker == after.changed_marker
      && before.regular && after.regular && !before.directory && !after.directory
      && !before.reparse && !after.reparse;
}

void ValidateUniqueFile(const Snapshot& snapshot, size_t maximum, bool allow_empty = false) {
  if (!snapshot.regular || snapshot.directory || snapshot.reparse || snapshot.links != 1
      || (!allow_empty && snapshot.size == 0) || snapshot.size > maximum) {
    throw NativeError("ALIAS", "opened object is not a bounded unique regular file");
  }
}

struct DirectoryState {
  explicit DirectoryState(NativeHandle value) : handle(value) {}
  ~DirectoryState() { CloseHandleSafe(handle); }
  NativeHandle handle = kInvalidHandle;
};

struct PublicationState {
  NativeHandle file = kInvalidHandle;
  std::string expected_digest;
  std::string expected_identity;
  std::wstring expected_name;
  uint64_t expected_size = 0;
  bool complete = false;
  ~PublicationState() {
#ifdef _WIN32
    if (!complete && file != kInvalidHandle) {
      try { DeleteOpenedHandle(file); } catch (...) { /* finalizers cannot report; the retained handle is still closed */ }
    }
#endif
    CloseHandleSafe(file);
  }
};

void FinalizeDirectory(napi_env, void* data, void*) {
  delete static_cast<DirectoryState*>(data);
}

void FinalizePublication(napi_env, void* data, void*) {
  delete static_cast<PublicationState*>(data);
}

DirectoryState* UnwrapDirectory(napi_env env, napi_value value) {
  DirectoryState* state = nullptr;
  CheckNapi(env, napi_unwrap(env, value, reinterpret_cast<void**>(&state)), "unwrap directory capability");
  if (state == nullptr || state->handle == kInvalidHandle) throw NativeError("INVALID_CAPABILITY", "directory capability is closed");
  return state;
}

PublicationState* UnwrapPublication(napi_env env, napi_value value) {
  PublicationState* state = nullptr;
  CheckNapi(env, napi_unwrap(env, value, reinterpret_cast<void**>(&state)), "unwrap publication token");
  if (state == nullptr || state->complete || state->file == kInvalidHandle) throw NativeError("INVALID_CAPABILITY", "publication token is closed");
  return state;
}

napi_value CreateString(napi_env env, const std::string& value) {
  napi_value result;
  CheckNapi(env, napi_create_string_utf8(env, value.c_str(), value.size(), &result), "create string");
  return result;
}

void SetProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  CheckNapi(env, napi_set_named_property(env, object, name, value), "set property");
}

napi_value CreateUint64(napi_env env, uint64_t value) {
  napi_value result;
  CheckNapi(env, napi_create_double(env, static_cast<double>(value), &result), "create number");
  return result;
}

napi_value CreateInt64BigInt(napi_env env, int64_t value) {
  napi_value result;
  CheckNapi(env, napi_create_bigint_int64(env, value, &result), "create bigint");
  return result;
}

napi_value DirectoryOpen(napi_env env, napi_callback_info info);
napi_value DirectoryOpenReadOnly(napi_env env, napi_callback_info info);
napi_value DirectoryEnsure(napi_env env, napi_callback_info info);
napi_value DirectoryList(napi_env env, napi_callback_info info);
napi_value DirectoryListBounded(napi_env env, napi_callback_info info);
napi_value DirectoryRead(napi_env env, napi_callback_info info);
napi_value DirectoryPublish(napi_env env, napi_callback_info info);
napi_value DirectoryDelete(napi_env env, napi_callback_info info);
napi_value PublicationCommit(napi_env env, napi_callback_info info);
napi_value PublicationRollback(napi_env env, napi_callback_info info);

napi_value CreateDirectoryObject(napi_env env, NativeHandle handle) {
  auto state = std::make_unique<DirectoryState>(handle);
  const Snapshot snapshot = InspectHandle(handle);
  napi_value identity = CreateString(env, snapshot.identity);
  napi_value object;
  CheckNapi(env, napi_create_object(env, &object), "create directory capability");
  napi_property_descriptor descriptors[] = {
    {"open", nullptr, DirectoryOpen, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openReadOnly", nullptr, DirectoryOpenReadOnly, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ensure", nullptr, DirectoryEnsure, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"list", nullptr, DirectoryList, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listBounded", nullptr, DirectoryListBounded, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, DirectoryRead, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publish", nullptr, DirectoryPublish, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"delete", nullptr, DirectoryDelete, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  CheckNapi(env, napi_define_properties(env, object, sizeof(descriptors) / sizeof(descriptors[0]), descriptors), "define directory methods");
  SetProperty(env, object, "identity", identity);
  CheckNapi(env, napi_wrap(env, object, state.get(), FinalizeDirectory, nullptr, nullptr), "wrap directory capability");
  state.release();
  return object;
}

napi_value CreatePublicationObject(napi_env env, std::unique_ptr<PublicationState> state,
    const Snapshot& snapshot, const std::string& digest, const std::wstring& name) {
  state->expected_digest = digest;
  state->expected_identity = snapshot.identity;
  state->expected_name = name;
  state->expected_size = snapshot.size;
  napi_value object;
  CheckNapi(env, napi_create_object(env, &object), "create publication token");
  napi_property_descriptor descriptors[] = {
    {"commit", nullptr, PublicationCommit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"rollback", nullptr, PublicationRollback, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  CheckNapi(env, napi_define_properties(env, object, 2, descriptors), "define publication methods");
  SetProperty(env, object, "identity", CreateString(env, snapshot.identity));
  SetProperty(env, object, "digest", CreateString(env, digest));
  SetProperty(env, object, "size", CreateUint64(env, snapshot.size));
  CheckNapi(env, napi_wrap(env, object, state.get(), FinalizePublication, nullptr, nullptr), "wrap publication token");
  state.release();
  return object;
}

std::vector<napi_value> Arguments(napi_env env, napi_callback_info info, size_t expected, napi_value* this_value) {
  size_t count = expected;
  std::vector<napi_value> values(expected);
  CheckNapi(env, napi_get_cb_info(env, info, &count, values.data(), this_value, nullptr), "read callback arguments");
  if (count != expected) throw NativeError("INVALID_ARGUMENT", "native filesystem call has the wrong argument count");
  return values;
}

NativeHandle Traverse(DirectoryState* state, const std::vector<std::string>& components,
    bool create, bool allow_missing, bool* absent = nullptr) {
  NativeHandle current = DuplicateDirectory(state->handle);
  try {
    for (size_t index = 0; index < components.size(); ++index) {
      bool component_absent = false;
      NativeHandle next = OpenChildDirectory(current, components[index], create, allow_missing, &component_absent);
      CloseHandleSafe(current);
      current = next;
      if (component_absent) {
        if (absent != nullptr) *absent = true;
        return kInvalidHandle;
      }
    }
    if (absent != nullptr) *absent = false;
    return current;
  } catch (...) {
    CloseHandleSafe(current);
    throw;
  }
}

NativeHandle TraverseReadOnly(DirectoryState* state, const std::vector<std::string>& components,
    bool* absent = nullptr) {
  NativeHandle current = DuplicateDirectory(state->handle);
  try {
    for (size_t index = 0; index < components.size(); ++index) {
      bool component_absent = false;
      NativeHandle next = OpenChildDirectory(current, components[index], false, true, &component_absent, false);
      CloseHandleSafe(current);
      current = next;
      if (component_absent) {
        if (absent != nullptr) *absent = true;
        return kInvalidHandle;
      }
    }
    if (absent != nullptr) *absent = false;
    return current;
  } catch (...) {
    CloseHandleSafe(current);
    throw;
  }
}

napi_value DirectoryOpen(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 1, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    bool absent = false;
    NativeHandle handle = Traverse(state, Components(env, args[0]), false, true, &absent);
    if (absent) {
      napi_value null_value;
      CheckNapi(env, napi_get_null(env, &null_value), "create null");
      return null_value;
    }
    return CreateDirectoryObject(env, handle);
  });
}

napi_value DirectoryOpenReadOnly(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 1, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    bool absent = false;
    NativeHandle handle = TraverseReadOnly(state, Components(env, args[0]), &absent);
    if (absent) {
      napi_value null_value;
      CheckNapi(env, napi_get_null(env, &null_value), "create null");
      return null_value;
    }
    return CreateDirectoryObject(env, handle);
  });
}

napi_value DirectoryEnsure(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 1, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    NativeHandle handle = Traverse(state, Components(env, args[0]), true, false);
    return CreateDirectoryObject(env, handle);
  });
}

size_t DirectoryMaximumEntries(napi_env env, napi_value value) {
  double number = 0;
  CheckNapi(env, napi_get_value_double(env, value, &number), "read maximum directory entries");
  if (!std::isfinite(number) || number < 1 || number > kMaximumDirectoryEntries
      || number != std::floor(number)) {
    throw NativeError("INVALID_ARGUMENT", "maximum directory entry bound is invalid");
  }
  return static_cast<size_t>(number);
}

napi_value DirectoryListWithMaximum(napi_env env, napi_callback_info info, bool bounded) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, bounded ? 1 : 0, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    const size_t maximum = bounded ? DirectoryMaximumEntries(env, args[0]) : kMaximumDirectoryEntries;
    struct Entry { std::string name; std::string type; };
    std::vector<Entry> entries;
#ifdef _WIN32
    std::array<uint8_t, 64U * 1024U> buffer{};
    bool restart = true;
    while (true) {
      BOOL ok = GetFileInformationByHandleEx(state->handle,
          restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          buffer.data(), static_cast<DWORD>(buffer.size()));
      restart = false;
      if (!ok) {
        DWORD code = GetLastError();
        if (code == ERROR_NO_MORE_FILES) break;
        throw NativeError("IO", WindowsFailure("enumerate opened directory", code));
      }
      auto* current = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
      while (current != nullptr) {
        std::wstring wide_name(current->FileName, current->FileNameLength / sizeof(wchar_t));
        if (wide_name != L"." && wide_name != L"..") {
          if (entries.size() >= maximum) {
            throw NativeError("ENUMERATION_LIMIT", "directory enumeration exceeds its native bound");
          }
          int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_name.data(), static_cast<int>(wide_name.size()), nullptr, 0, nullptr, nullptr);
          if (length <= 0) throw NativeError("INVALID_COMPONENT", "directory entry name is not valid UTF-8");
          std::string name(static_cast<size_t>(length), '\0');
          WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_name.data(), static_cast<int>(wide_name.size()), name.data(), length, nullptr, nullptr);
          std::string type = (current->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
              ? "reparse" : (current->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? "directory" : "file";
          entries.push_back({std::move(name), std::move(type)});
        }
        if (current->NextEntryOffset == 0) break;
        current = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<uint8_t*>(current) + current->NextEntryOffset);
      }
    }
#else
    NativeHandle duplicate = DuplicateDirectory(state->handle);
    DIR* directory = fdopendir(duplicate);
    if (directory == nullptr) {
      CloseHandleSafe(duplicate);
      throw NativeError("IO", PosixFailure("fdopendir"));
    }
    rewinddir(directory);
    errno = 0;
    while (dirent* item = readdir(directory)) {
      if (std::strcmp(item->d_name, ".") == 0 || std::strcmp(item->d_name, "..") == 0) continue;
      if (entries.size() >= maximum) {
        closedir(directory);
        throw NativeError("ENUMERATION_LIMIT", "directory enumeration exceeds its native bound");
      }
      std::string name(item->d_name);
      struct stat metadata{};
      if (fstatat(state->handle, name.c_str(), &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
        closedir(directory);
        throw NativeError("UNSTABLE", PosixFailure("fstatat directory entry"));
      }
      std::string type = S_ISLNK(metadata.st_mode) ? "reparse" : S_ISDIR(metadata.st_mode) ? "directory" : S_ISREG(metadata.st_mode) ? "file" : "other";
      entries.push_back({std::move(name), std::move(type)});
      errno = 0;
    }
    int enumeration_error = errno;
    closedir(directory);
    if (enumeration_error != 0) throw NativeError("IO", PosixFailure("readdir", enumeration_error));
#endif
    std::sort(entries.begin(), entries.end(), [](const Entry& left, const Entry& right) { return left.name < right.name; });
    napi_value result;
    CheckNapi(env, napi_create_array_with_length(env, entries.size(), &result), "create entry array");
    for (uint32_t index = 0; index < entries.size(); ++index) {
      napi_value item;
      CheckNapi(env, napi_create_object(env, &item), "create entry");
      SetProperty(env, item, "name", CreateString(env, entries[index].name));
      SetProperty(env, item, "type", CreateString(env, entries[index].type));
      CheckNapi(env, napi_set_element(env, result, index, item), "set entry");
    }
    return result;
  });
}

napi_value DirectoryList(napi_env env, napi_callback_info info) {
  return DirectoryListWithMaximum(env, info, false);
}

napi_value DirectoryListBounded(napi_env env, napi_callback_info info) {
  return DirectoryListWithMaximum(env, info, true);
}

std::pair<const uint8_t*, size_t> Buffer(napi_env env, napi_value value) {
  bool is_buffer = false;
  CheckNapi(env, napi_is_buffer(env, value, &is_buffer), "inspect buffer");
  if (!is_buffer) throw NativeError("INVALID_ARGUMENT", "object bytes must be a Buffer");
  void* data = nullptr;
  size_t length = 0;
  CheckNapi(env, napi_get_buffer_info(env, value, &data, &length), "read buffer");
  return {static_cast<const uint8_t*>(data), length};
}

size_t MaximumBytes(napi_env env, napi_value value) {
  double number = 0;
  CheckNapi(env, napi_get_value_double(env, value, &number), "read maximum bytes");
  if (number < 1 || number > kMaximumFileBytes || number != static_cast<double>(static_cast<size_t>(number))) {
    throw NativeError("INVALID_ARGUMENT", "maximum byte bound is invalid");
  }
  return static_cast<size_t>(number);
}

NativeHandle OpenFileForRead(DirectoryState* state, const std::string& name, bool allow_missing, bool* absent = nullptr) {
#ifdef _WIN32
  return NtOpenRelative(state->handle, Wide(name), GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
      FILE_SHARE_READ, allow_missing, absent);
#else
  NativeHandle handle = openat(state->handle, name.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (handle < 0) {
    if (allow_missing && errno == ENOENT) {
      if (absent != nullptr) *absent = true;
      return kInvalidHandle;
    }
    throw NativeError(errno == ELOOP ? "REPARSE_POINT" : "IO", PosixFailure("openat file"));
  }
  if (absent != nullptr) *absent = false;
  return handle;
#endif
}

napi_value ReadResult(napi_env env, NativeHandle handle, size_t maximum) {
  Snapshot before = InspectHandle(handle);
  ValidateUniqueFile(before, maximum);
  std::vector<uint8_t> bytes = ReadExactHandle(handle, static_cast<size_t>(before.size));
  Snapshot after = InspectHandle(handle);
  if (!StableFile(before, after) || bytes.size() != after.size) throw NativeError("UNSTABLE", "opened object identity or bytes changed during read");
  const std::string digest = Digest(bytes.data(), bytes.size());
  napi_value result;
  napi_value buffer;
  void* copied = nullptr;
  CheckNapi(env, napi_create_buffer_copy(env, bytes.size(), bytes.data(), &copied, &buffer), "copy object bytes");
  CheckNapi(env, napi_create_object(env, &result), "create read result");
  SetProperty(env, result, "bytes", buffer);
  SetProperty(env, result, "digest", CreateString(env, digest));
  SetProperty(env, result, "identity", CreateString(env, after.identity));
  SetProperty(env, result, "mtime_ns", CreateInt64BigInt(env, after.modified_ns));
  SetProperty(env, result, "size", CreateUint64(env, after.size));
  return result;
}

napi_value DirectoryRead(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 3, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    std::string name = Utf8(env, args[0], "file name");
    if (!ClosedComponent(name)) throw NativeError("INVALID_COMPONENT", "file name is not a closed component");
    const size_t maximum = MaximumBytes(env, args[1]);
    bool allow_missing = false;
    CheckNapi(env, napi_get_value_bool(env, args[2], &allow_missing), "read missing policy");
    bool absent = false;
    NativeHandle handle = OpenFileForRead(state, name, allow_missing, &absent);
    if (absent) {
      napi_value null_value;
      CheckNapi(env, napi_get_null(env, &null_value), "create null");
      return null_value;
    }
    try {
      napi_value result = ReadResult(env, handle, maximum);
      CloseHandleSafe(handle);
      return result;
    } catch (...) {
      CloseHandleSafe(handle);
      throw;
    }
  });
}

napi_value DirectoryPublish(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
#ifndef _WIN32
    (void)info;
    throw NativeError("REFUSED_EXACT_DELETE_UNAVAILABLE",
        "POSIX predictive publication is disabled because exact hostile rollback cannot be guaranteed");
#else
    napi_value self;
    auto args = Arguments(env, info, 4, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    DirectoryState* staging = UnwrapDirectory(env, args[3]);
    if (InspectHandle(state->handle).identity == InspectHandle(staging->handle).identity) {
      throw NativeError("INVALID_ARGUMENT", "publication staging and destination directories must differ");
    }
    std::string name = Utf8(env, args[0], "file name");
    if (!ClosedComponent(name)) throw NativeError("INVALID_COMPONENT", "file name is not a closed component");
    auto [bytes, length] = Buffer(env, args[1]);
    if (length == 0 || length > kMaximumFileBytes) throw NativeError("INVALID_ARGUMENT", "publication bytes exceed the closed bound");
    std::string expected_digest = Utf8(env, args[2], "expected digest");
    if (!IsExpectedDigest(expected_digest) || Digest(bytes, length) != expected_digest) {
      throw NativeError("DIGEST_MISMATCH", "publication input digest does not match its bytes");
    }
    auto publication = std::make_unique<PublicationState>();
    publication->file = CreateStagedFile(staging->handle);
    try {
      Snapshot before = InspectHandle(publication->file);
      ValidateUniqueFile(before, kMaximumFileBytes, true);
      if (before.size != 0) throw NativeError("UNSTABLE", "new publication handle is not empty");
      WriteExactHandle(publication->file, bytes, length);
      Snapshot written = InspectHandle(publication->file);
      ValidateUniqueFile(written, kMaximumFileBytes);
      std::vector<uint8_t> rebound = ReadExactHandle(publication->file, length);
      Snapshot after = InspectHandle(publication->file);
      if (before.identity != after.identity || !StableFile(written, after)
          || rebound.size() != length || std::memcmp(rebound.data(), bytes, length) != 0
          || Digest(rebound.data(), rebound.size()) != expected_digest) {
        throw NativeError("UNSTABLE", "published bytes or opened file identity changed during verification");
      }
      RenameOpenedHandle(publication->file, state->handle, Wide(name));
      Snapshot published = InspectHandle(publication->file);
      ValidateUniqueFile(published, kMaximumFileBytes);
      if (published.identity != after.identity || published.size != after.size || published.links != after.links) {
        throw NativeError("UNSTABLE", "handle-relative publication rename changed the opened file identity");
      }
      return CreatePublicationObject(env, std::move(publication), published, expected_digest, Wide(name));
    } catch (...) {
      try {
        if (publication && publication->file != kInvalidHandle) DeleteOpenedHandle(publication->file);
      } catch (...) { /* preserve the publication validation failure */ }
      throw;
    }
#endif
  });
}

napi_value PublicationCommit(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    Arguments(env, info, 0, &self);
    PublicationState* state = UnwrapPublication(env, self);
#ifdef _WIN32
    ValidateOpenedComponent(state->file, state->expected_name, false);
    const Snapshot before = InspectHandle(state->file);
    ValidateUniqueFile(before, kMaximumFileBytes);
    const std::vector<uint8_t> bytes = ReadExactHandle(state->file, static_cast<size_t>(before.size));
    const Snapshot after = InspectHandle(state->file);
    if (!StableFile(before, after) || after.identity != state->expected_identity
        || after.size != state->expected_size || Digest(bytes.data(), bytes.size()) != state->expected_digest) {
      throw NativeError("UNSTABLE", "publication changed before commit");
    }
#endif
    CloseHandleSafe(state->file);
    state->file = kInvalidHandle;
    state->complete = true;
    napi_value undefined;
    CheckNapi(env, napi_get_undefined(env, &undefined), "create undefined");
    return undefined;
  });
}

napi_value PublicationRollback(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
#ifndef _WIN32
    (void)info;
    throw NativeError("REFUSED_EXACT_DELETE_UNAVAILABLE",
        "POSIX predictive rollback is disabled because unlinkat cannot conditionally unlink an opened inode");
#else
    napi_value self;
    Arguments(env, info, 0, &self);
    PublicationState* state = UnwrapPublication(env, self);
    DeleteOpenedHandle(state->file);
    CloseHandleSafe(state->file);
    state->file = kInvalidHandle;
    state->complete = true;
    napi_value undefined;
    CheckNapi(env, napi_get_undefined(env, &undefined), "create undefined");
    return undefined;
#endif
  });
}

napi_value DirectoryDelete(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
#ifndef _WIN32
    (void)info;
    throw NativeError("REFUSED_EXACT_DELETE_UNAVAILABLE",
        "POSIX predictive deletion is disabled because unlinkat cannot conditionally unlink an opened inode");
#else
    napi_value self;
    auto args = Arguments(env, info, 3, &self);
    DirectoryState* state = UnwrapDirectory(env, self);
    std::string name = Utf8(env, args[0], "file name");
    std::string expected_identity = Utf8(env, args[1], "expected identity");
    std::string expected_digest = Utf8(env, args[2], "expected digest");
    if (!ClosedComponent(name) || expected_identity.empty() || !IsExpectedDigest(expected_digest)) {
      throw NativeError("INVALID_ARGUMENT", "delete binding is invalid");
    }
    NativeHandle handle = NtOpenRelative(state->handle, Wide(name),
        GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_SHARE_READ, false);
    try {
      Snapshot before = InspectHandle(handle);
      ValidateUniqueFile(before, kMaximumFileBytes);
      std::vector<uint8_t> bytes = ReadExactHandle(handle, static_cast<size_t>(before.size));
      Snapshot after = InspectHandle(handle);
      if (!StableFile(before, after) || after.identity != expected_identity || Digest(bytes.data(), bytes.size()) != expected_digest) {
        throw NativeError("DELETE_REFUSED", "delete target does not match the opened identity and digest");
      }
      DeleteOpenedHandle(handle);
      CloseHandleSafe(handle);
      handle = kInvalidHandle;
      napi_value result;
      CheckNapi(env, napi_get_boolean(env, true, &result), "create deletion result");
      return result;
    } catch (...) {
      CloseHandleSafe(handle);
      throw;
    }
#endif
  });
}

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 1, &self);
    std::string root = Utf8(env, args[0], "state root");
    NativeHandle handle = OpenAbsoluteRoot(root);
    return CreateDirectoryObject(env, handle);
  });
}

napi_value OpenRootReadOnly(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self;
    auto args = Arguments(env, info, 1, &self);
    std::string root = Utf8(env, args[0], "state root");
    bool absent = false;
    NativeHandle handle = OpenAbsoluteRootReadOnly(root, &absent);
    if (absent) {
      napi_value null_value;
      CheckNapi(env, napi_get_null(env, &null_value), "create null");
      return null_value;
    }
    return CreateDirectoryObject(env, handle);
  });
}

napi_value Init(napi_env env, napi_value exports) {
  return Guard(env, [&]() {
    napi_value open_root;
    CheckNapi(env, napi_create_function(env, "openRoot", NAPI_AUTO_LENGTH, OpenRoot, nullptr, &open_root), "create openRoot");
    SetProperty(env, exports, "openRoot", open_root);
    napi_value open_root_read_only;
    CheckNapi(env, napi_create_function(env, "openRootReadOnly", NAPI_AUTO_LENGTH, OpenRootReadOnly, nullptr, &open_root_read_only), "create openRootReadOnly");
    SetProperty(env, exports, "openRootReadOnly", open_root_read_only);
    napi_value abi;
    CheckNapi(env, napi_create_uint32(env, kAbiVersion, &abi), "create ABI version");
    SetProperty(env, exports, "abiVersion", abi);
    SetProperty(env, exports, "implementationVersion", CreateString(env, "sei.predictive-native-fs@1"));
    SetProperty(env, exports, "sourceDigest", CreateString(env, kSourceDigest));
#ifdef _WIN32
    SetProperty(env, exports, "platform", CreateString(env, "win32"));
#else
    SetProperty(env, exports, "platform", CreateString(env, "posix"));
#endif
#if defined(_M_X64) || defined(__x86_64__)
    SetProperty(env, exports, "architecture", CreateString(env, "x64"));
#elif defined(_M_ARM64) || defined(__aarch64__)
    SetProperty(env, exports, "architecture", CreateString(env, "arm64"));
#else
    SetProperty(env, exports, "architecture", CreateString(env, "unsupported"));
#endif
    return exports;
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
