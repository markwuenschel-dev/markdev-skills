#!/usr/bin/env python3
"""Pathless CPython analyzer targeting the closed Python 3.13 grammar protocol."""

from __future__ import annotations

import json
import ast
import hashlib
import io
import os
import re
import struct
import sys
import tokenize


PROTOCOL = "sei.python-ast@1"
ANALYZER_VERSION = "sei.python-ast@1"
PARSER_RUNTIME = "cpython-3.13"
GRAMMAR_TARGET = [3, 13]
REQUEST_MAGIC = b"SEIPYA1\0"
RESPONSE_MAGIC = b"SEIPYR1\0"
REQUEST_KEYS = {
    "analyzer_version", "files", "grammar_target", "index_digest", "limits",
    "parser_runtime", "protocol", "request_id",
}
FILE_KEYS = {"blob_oid", "byte_length", "content_key", "ordinal", "sha256"}
LIMIT_KEYS = {"max_batch_bytes", "max_batch_files", "max_file_bytes"}
HARD_LIMITS = {"max_batch_bytes": 16 * 1024 * 1024, "max_batch_files": 128, "max_file_bytes": 8 * 1024 * 1024}
_WINDOWS_JOB_HANDLE: int | None = None


def establish_process_supervisor() -> None:
    """Put this helper and every descendant in a kill-on-close Windows job."""
    global _WINDOWS_JOB_HANDLE
    if os.name != "nt" or _WINDOWS_JOB_HANDLE is not None:
        return
    import ctypes
    from ctypes import wintypes

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
    information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    information.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    try:
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(information), ctypes.sizeof(information)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
        if not kernel32.AssignProcessToJobObject(handle, kernel32.GetCurrentProcess()):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    except BaseException:
        kernel32.CloseHandle(handle)
        raise
    _WINDOWS_JOB_HANDLE = int(handle)


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def probe() -> int:
    if sys.implementation.name != "cpython" or sys.version_info[:2] < (3, 13):
        sys.stderr.write("python-ast requires CPython 3.13 or newer\n")
        return 2
    # Import the required modules during the probe so an incomplete runtime fails before admission.
    import ast  # noqa: F401
    import hashlib  # noqa: F401
    import io  # noqa: F401
    import struct  # noqa: F401
    import tokenize  # noqa: F401

    sys.stdout.buffer.write(canonical_json({
        "analyzer_version": ANALYZER_VERSION,
        "grammar_target": GRAMMAR_TARGET,
        "implementation": sys.implementation.name,
        "parser_runtime": PARSER_RUNTIME,
        "protocol": PROTOCOL,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    }))
    return 0


def require_closed(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{label} does not have the closed protocol fields")
    return value


def location(node: ast.AST) -> dict[str, int]:
    return {
        "col_offset": int(getattr(node, "col_offset", 0)),
        "end_col_offset": int(getattr(node, "end_col_offset", getattr(node, "col_offset", 0))),
        "end_lineno": int(getattr(node, "end_lineno", getattr(node, "lineno", 1))),
        "lineno": int(getattr(node, "lineno", 1)),
    }


class ComplexityVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.points = 0

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # nested scope
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # nested scope
        return

    def visit_Lambda(self, node: ast.Lambda) -> None:  # nested scope
        return

    def visit_If(self, node: ast.If) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_While(self, node: ast.While) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:
        self.points += 1
        self.generic_visit(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        self.points += max(0, len(node.values) - 1)
        self.generic_visit(node)

    def visit_comprehension(self, node: ast.comprehension) -> None:
        self.points += 1 + len(node.ifs)
        self.generic_visit(node)

    def visit_match_case(self, node: ast.match_case) -> None:
        self.points += 1
        self.generic_visit(node)


def callable_complexity(node: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    visitor = ComplexityVisitor()
    for statement in node.body:
        visitor.visit(statement)
    return 1 + visitor.points


class FactVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.callables: list[dict[str, object]] = []
        self.imports: list[dict[str, object]] = []
        self.scope: list[tuple[str, str]] = []

    def qualified_name(self, name: str) -> str:
        parts: list[str] = []
        for scope_name, scope_kind in self.scope:
            parts.append(scope_name)
            if scope_kind == "function":
                parts.append("<locals>")
        parts.append(name)
        return ".".join(parts)

    def callable_kind(self, async_definition: bool) -> str:
        parent_kind = self.scope[-1][1] if self.scope else None
        if parent_kind == "class":
            return "async-method" if async_definition else "method"
        if any(kind == "function" for _, kind in self.scope):
            return "nested-async-function" if async_definition else "nested-function"
        return "async-function" if async_definition else "function"

    def record_callable(self, node: ast.FunctionDef | ast.AsyncFunctionDef, async_definition: bool) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *[item for item in node.args.kw_defaults if item is not None]]:
            self.visit(default)
        for argument in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            if argument.annotation is not None:
                self.visit(argument.annotation)
        if node.args.vararg is not None and node.args.vararg.annotation is not None:
            self.visit(node.args.vararg.annotation)
        if node.args.kwarg is not None and node.args.kwarg.annotation is not None:
            self.visit(node.args.kwarg.annotation)
        if node.returns is not None:
            self.visit(node.returns)
        for type_parameter in getattr(node, "type_params", []):
            self.visit(type_parameter)
        self.callables.append({
            "complexity": callable_complexity(node),
            "kind": self.callable_kind(async_definition),
            **location(node),
            "qualified_name": self.qualified_name(node.name),
        })
        self.scope.append((node.name, "function"))
        for statement in node.body:
            self.visit(statement)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.record_callable(node, False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.record_callable(node, True)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword.value)
        for type_parameter in getattr(node, "type_params", []):
            self.visit(type_parameter)
        self.scope.append((node.name, "class"))
        for statement in node.body:
            self.visit(statement)
        self.scope.pop()

    def visit_Import(self, node: ast.Import) -> None:
        self.imports.append({
            "kind": "import", "level": 0, **location(node), "module": None,
            "names": [{"asname": alias.asname, "name": alias.name} for alias in node.names],
        })

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self.imports.append({
            "kind": "from", "level": node.level, **location(node), "module": node.module,
            "names": [{"asname": alias.asname, "name": alias.name} for alias in node.names],
        })

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name) and node.func.id == "__import__":
            self.imports.append({
                "kind": "dynamic-builtin", "level": 0, **location(node), "module": None, "names": [],
            })
        elif (isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"
              and isinstance(node.func.value, ast.Name) and node.func.value.id == "importlib"):
            self.imports.append({
                "kind": "dynamic-importlib", "level": 0, **location(node), "module": None, "names": [],
            })
        self.generic_visit(node)


def bounded_message(error: BaseException) -> str:
    message = str(error).replace("\x00", "\\0").replace("\r", " ").replace("\n", " ").strip()
    return message[:512] or error.__class__.__name__


def error_result(file_record: dict[str, object], code: str, error: BaseException) -> dict[str, object]:
    line = getattr(error, "lineno", None)
    offset = getattr(error, "offset", None)
    end_line = getattr(error, "end_lineno", None)
    end_offset = getattr(error, "end_offset", None)
    return {
        "content_key": file_record["content_key"],
        "error": {
            "code": code,
            "col_offset": max(0, int(offset) - 1) if isinstance(offset, int) else None,
            "end_col_offset": max(0, int(end_offset) - 1) if isinstance(end_offset, int) else None,
            "end_lineno": int(end_line) if isinstance(end_line, int) else None,
            "lineno": int(line) if isinstance(line, int) else None,
            "message": bounded_message(error),
        },
        "ordinal": file_record["ordinal"],
        "sha256": file_record["sha256"],
        "status": "error",
    }


def analyze_file(file_record: dict[str, object], source: bytes) -> dict[str, object]:
    try:
        detected, _ = tokenize.detect_encoding(io.BytesIO(source).readline)
        text = source.decode(detected)
    except (LookupError, SyntaxError, UnicodeDecodeError) as error:
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE-ENCODING", error)
    if "\x00" in text:
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE-NULL-BYTE", ValueError("source contains a null byte"))
    try:
        tree = ast.parse(
            text,
            filename=f"<sei-blob:{file_record['ordinal']}>",
            mode="exec",
            type_comments=True,
            feature_version=(3, 13),
            optimize=-1,
        )
    except SyntaxError as error:
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE-SYNTAX", error)
    except RecursionError as error:
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE-RECURSION", error)
    except Exception as error:  # ast parser failures remain typed per file
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE", error)
    visitor = FactVisitor()
    try:
        visitor.visit(tree)
    except RecursionError as error:
        return error_result(file_record, "FAIL-PYTHON-AST-PARSE-RECURSION", error)
    visitor.callables.sort(key=lambda item: (
        item["lineno"], item["col_offset"], item["end_lineno"], item["end_col_offset"], item["qualified_name"],
    ))
    visitor.imports.sort(key=lambda item: (
        item["lineno"], item["col_offset"], item["end_lineno"], item["end_col_offset"],
        item["kind"], item["level"], item["module"] or "", canonical_json(item["names"]),
    ))
    return {
        "callables": visitor.callables,
        "content_key": file_record["content_key"],
        "imports": visitor.imports,
        "ordinal": file_record["ordinal"],
        "sha256": file_record["sha256"],
        "status": "ok",
    }


def analyze() -> int:
    if sys.implementation.name != "cpython" or sys.version_info[:2] < (3, 13):
        sys.stderr.write("python-ast requires CPython 3.13 or newer\n")
        return 2
    raw = sys.stdin.buffer.read()
    if len(raw) < 12 or raw[:8] != REQUEST_MAGIC:
        sys.stderr.write("invalid request frame\n")
        return 3
    header_length = struct.unpack(">I", raw[8:12])[0]
    if header_length <= 0 or header_length > 1024 * 1024 or 12 + header_length > len(raw):
        sys.stderr.write("invalid request header length\n")
        return 3
    header_bytes = raw[12:12 + header_length]
    try:
        header = require_closed(json.loads(header_bytes), REQUEST_KEYS, "request")
        if canonical_json(header) != header_bytes:
            raise ValueError("request header is not canonical JSON")
        limits = require_closed(header["limits"], LIMIT_KEYS, "limits")
        files = header["files"]
        if header["protocol"] != PROTOCOL or header["analyzer_version"] != ANALYZER_VERSION:
            raise ValueError("wrong analyzer protocol identity")
        if header["parser_runtime"] != PARSER_RUNTIME or header["grammar_target"] != GRAMMAR_TARGET:
            raise ValueError("wrong parser runtime identity")
        if not isinstance(header["request_id"], str) or re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", header["request_id"]) is None:
            raise ValueError("invalid request identity")
        if not isinstance(header["index_digest"], str) or re.fullmatch(r"sha256:[0-9a-f]{64}", header["index_digest"]) is None:
            raise ValueError("invalid index identity")
        for limit_name, hard_limit in HARD_LIMITS.items():
            limit_value = limits[limit_name]
            if isinstance(limit_value, bool) or not isinstance(limit_value, int) or limit_value <= 0 or limit_value > hard_limit:
                raise ValueError(f"invalid {limit_name}")
        if not isinstance(files, list) or not files or len(files) > limits["max_batch_files"]:
            raise ValueError("invalid file count")
        payload_offset = 12 + header_length
        payload_bytes = 0
        results: list[dict[str, object]] = []
        for expected_ordinal, raw_record in enumerate(files):
            record = require_closed(raw_record, FILE_KEYS, f"files[{expected_ordinal}]")
            if record["ordinal"] != expected_ordinal:
                raise ValueError("file ordinals must be contiguous")
            blob_oid = record["blob_oid"]
            if not isinstance(blob_oid, str) or re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", blob_oid) is None:
                raise ValueError("invalid blob oid")
            algorithm = "sha1" if len(blob_oid) == 40 else "sha256"
            if record["content_key"] != f"git-blob:{algorithm}:{blob_oid}":
                raise ValueError("content key does not bind blob oid")
            if not isinstance(record["sha256"], str) or re.fullmatch(r"[0-9a-f]{64}", record["sha256"]) is None:
                raise ValueError("invalid file hash")
            length = record["byte_length"]
            if not isinstance(length, int) or isinstance(length, bool) or length < 0 or length > limits["max_file_bytes"]:
                raise ValueError("invalid file byte length")
            payload_bytes += length
            if payload_bytes > limits["max_batch_bytes"]:
                raise ValueError("batch payload exceeds max_batch_bytes")
            source = raw[payload_offset:payload_offset + length]
            if len(source) != length:
                raise ValueError("truncated file payload")
            payload_offset += length
            if hashlib.sha256(source).hexdigest() != record["sha256"]:
                raise ValueError("file hash mismatch")
            results.append(analyze_file(record, source))
        if payload_offset != len(raw):
            raise ValueError("trailing request bytes")
        failed = sum(result["status"] == "error" for result in results)
        status = "ok" if failed == 0 else "error" if failed == len(results) else "partial"
        response = {
            "analyzer_version": ANALYZER_VERSION,
            "diagnostics": {"files_failed": failed, "files_received": len(results), "files_succeeded": len(results) - failed},
            "grammar_target": GRAMMAR_TARGET,
            "parser_runtime": PARSER_RUNTIME,
            "protocol": PROTOCOL,
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "request_id": header["request_id"],
            "results": results,
            "status": status,
        }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        sys.stderr.write(f"invalid request: {bounded_message(error)}\n")
        return 3
    body = canonical_json(response)
    sys.stdout.buffer.write(RESPONSE_MAGIC + struct.pack(">I", len(body)) + body)
    return 0


def main() -> int:
    try:
        establish_process_supervisor()
    except OSError as error:
        sys.stderr.write(f"python-ast process supervisor unavailable: {bounded_message(error)}\n")
        return 2
    if len(sys.argv) == 2 and sys.argv[1] == "--probe":
        return probe()
    if len(sys.argv) == 2 and sys.argv[1] == "--analyze":
        return analyze()
    sys.stderr.write("usage: python-ast.py --probe|--analyze\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
