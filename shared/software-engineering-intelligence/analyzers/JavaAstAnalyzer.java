import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.CaseLabelTree;
import com.sun.source.tree.CaseTree;
import com.sun.source.tree.CatchTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.DoWhileLoopTree;
import com.sun.source.tree.EnhancedForLoopTree;
import com.sun.source.tree.ForLoopTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LineMap;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.WhileLoopTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.TreeScanner;
import com.sun.source.util.Trees;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

final class JavaAstAnalyzer {
    private static final byte[] REQUEST_MAGIC = new byte[] { 'S', 'E', 'I', 'J', 'V', 'A', '1', 0 };
    private static final byte[] RESPONSE_MAGIC = new byte[] { 'S', 'E', 'I', 'J', 'V', 'R', '1', 0 };
    private static final String ANALYZER_VERSION = "sei.java-ast@1";
    private static final String PROTOCOL = "sei.java-ast@1";
    private static final String PARSER_RUNTIME = "jdk.compiler";
    private static final int GRAMMAR_TARGET = 25;
    private static final int HARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
    private static final int HARD_MAX_BATCH_FILES = 128;
    private static final int HARD_MAX_BATCH_BYTES = 16 * 1024 * 1024;
    private static final int HARD_MAX_METADATA_BYTES = 1024 * 1024;
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern SOURCE_HASH = Pattern.compile("sha256:[0-9a-f]{64}");
    private static final HexFormat HEX = HexFormat.of();

    private static final class ProtocolFailure extends Exception {
        ProtocolFailure(String message) { super(message); }
    }

    private record InputFile(int ordinal, String contentKey, byte[] bytes, String sha256) {}
    private record Request(String requestId, String indexDigest, List<InputFile> files) {}
    private record Span(int startOffset, int endOffset, long startLine, long startColumn, long endLine, long endColumn) {}
    private record CallableFact(String kind, String qualifiedName, int complexity, Span span) {}
    private record ImportFact(String qualifiedName, boolean isStatic, boolean wildcard, Span span) {}
    private record ParseError(String code, Long line, Long column, String compilerCode) {}
    private record FileResult(
        int ordinal,
        String contentKey,
        String sha256,
        String status,
        String packageName,
        List<CallableFact> callables,
        List<ImportFact> imports,
        ParseError error
    ) {}

    private static final class InMemorySource extends SimpleJavaFileObject {
        private final String source;

        InMemorySource(int ordinal, String source) {
            super(URI.create("string:///sei-jvm/" + ordinal + ".java"), JavaFileObject.Kind.SOURCE);
            this.source = source;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return source;
        }
    }

    private static final class ComplexityScanner extends TreeScanner<Void, Void> {
        int complexity = 1;

        @Override public Void visitIf(IfTree node, Void unused) { complexity++; return super.visitIf(node, unused); }
        @Override public Void visitForLoop(ForLoopTree node, Void unused) { complexity++; return super.visitForLoop(node, unused); }
        @Override public Void visitEnhancedForLoop(EnhancedForLoopTree node, Void unused) { complexity++; return super.visitEnhancedForLoop(node, unused); }
        @Override public Void visitWhileLoop(WhileLoopTree node, Void unused) { complexity++; return super.visitWhileLoop(node, unused); }
        @Override public Void visitDoWhileLoop(DoWhileLoopTree node, Void unused) { complexity++; return super.visitDoWhileLoop(node, unused); }
        @Override public Void visitCatch(CatchTree node, Void unused) { complexity++; return super.visitCatch(node, unused); }
        @Override public Void visitConditionalExpression(ConditionalExpressionTree node, Void unused) { complexity++; return super.visitConditionalExpression(node, unused); }

        @Override
        public Void visitCase(CaseTree node, Void unused) {
            for (CaseLabelTree label : node.getLabels()) {
                if (label.getKind() != Tree.Kind.DEFAULT_CASE_LABEL) complexity++;
            }
            return super.visitCase(node, unused);
        }

        @Override
        public Void visitBinary(BinaryTree node, Void unused) {
            if (node.getKind() == Tree.Kind.CONDITIONAL_AND || node.getKind() == Tree.Kind.CONDITIONAL_OR) complexity++;
            return super.visitBinary(node, unused);
        }

        @Override public Void visitClass(ClassTree node, Void unused) { return null; }
        @Override public Void visitMethod(MethodTree node, Void unused) { return null; }
        @Override public Void visitLambdaExpression(LambdaExpressionTree node, Void unused) { return null; }
    }

    private static final class FactCollector extends TreePathScanner<Void, Void> {
        private final CompilationUnitTree unit;
        private final SourcePositions positions;
        private final LineMap lines;
        private final String packageName;
        private final Deque<String> classes = new ArrayDeque<>();
        private final Deque<String> callables = new ArrayDeque<>();
        private final List<CallableFact> callableFacts = new ArrayList<>();

        FactCollector(CompilationUnitTree unit, SourcePositions positions) throws ProtocolFailure {
            this.unit = unit;
            this.positions = positions;
            this.lines = unit.getLineMap();
            if (this.lines == null) throw new ProtocolFailure("compilation unit did not expose a line map");
            this.packageName = unit.getPackageName() == null ? null : unit.getPackageName().toString();
        }

        List<CallableFact> callables() { return callableFacts; }

        private Span span(Tree tree) throws ProtocolFailure {
            long start = positions.getStartPosition(unit, tree);
            long end = positions.getEndPosition(unit, tree);
            if (start < 0 || end <= start || start > Integer.MAX_VALUE || end > Integer.MAX_VALUE) {
                throw new ProtocolFailure("compiler AST exposed an invalid source position");
            }
            long inclusiveEnd = end - 1;
            return new Span(
                (int) start,
                (int) end,
                lines.getLineNumber(start),
                lines.getColumnNumber(start),
                lines.getLineNumber(inclusiveEnd),
                lines.getColumnNumber(inclusiveEnd) + 1
            );
        }

        private String classPrefix() {
            List<String> parts = new ArrayList<>();
            if (packageName != null && !packageName.isEmpty()) parts.add(packageName);
            parts.addAll(classes);
            return String.join(".", parts);
        }

        private int complexity(Tree body) {
            ComplexityScanner scanner = new ComplexityScanner();
            scanner.scan(body, null);
            return scanner.complexity;
        }

        @Override
        public Void visitClass(ClassTree node, Void unused) {
            String name = node.getSimpleName().toString();
            if (name.isEmpty()) {
                try {
                    Span location = span(node);
                    name = "anonymous@" + location.startLine() + ":" + location.startColumn();
                } catch (ProtocolFailure failure) {
                    throw new IllegalStateException(failure);
                }
            }
            classes.addLast(name);
            try {
                return super.visitClass(node, unused);
            } finally {
                classes.removeLast();
            }
        }

        @Override
        public Void visitMethod(MethodTree node, Void unused) {
            if (node.getBody() == null) return super.visitMethod(node, unused);
            String rawName = node.getName().toString();
            boolean constructor = rawName.equals("<init>");
            String parameters = node.getParameters().stream()
                .map(parameter -> parameter.getType() == null ? "?" : parameter.getType().toString().replaceAll("\\s+", " ").trim())
                .reduce((left, right) -> left + "," + right)
                .orElse("");
            String qualifiedName = classPrefix() + "." + (constructor ? "<init>" : rawName) + "(" + parameters + ")";
            try {
                callableFacts.add(new CallableFact(constructor ? "constructor" : "method", qualifiedName, complexity(node.getBody()), span(node)));
            } catch (ProtocolFailure failure) {
                throw new IllegalStateException(failure);
            }
            callables.addLast(qualifiedName);
            try {
                return super.visitMethod(node, unused);
            } finally {
                callables.removeLast();
            }
        }

        @Override
        public Void visitLambdaExpression(LambdaExpressionTree node, Void unused) {
            try {
                Span location = span(node);
                String owner = callables.isEmpty() ? classPrefix() : callables.getLast();
                String qualifiedName = owner + "#lambda@" + location.startLine() + ":" + location.startColumn();
                callableFacts.add(new CallableFact("lambda", qualifiedName, complexity(node.getBody()), location));
                callables.addLast(qualifiedName);
                try {
                    return super.visitLambdaExpression(node, unused);
                } finally {
                    callables.removeLast();
                }
            } catch (ProtocolFailure failure) {
                throw new IllegalStateException(failure);
            }
        }

        @Override
        public Void visitBlock(BlockTree node, Void unused) {
            TreePath parentPath = getCurrentPath() == null ? null : getCurrentPath().getParentPath();
            if (parentPath == null || !(parentPath.getLeaf() instanceof ClassTree)) return super.visitBlock(node, unused);
            try {
                Span location = span(node);
                String marker = node.isStatic() ? "$clinit" : "$init";
                String qualifiedName = classPrefix() + "." + marker + "@" + location.startLine() + ":" + location.startColumn();
                callableFacts.add(new CallableFact(
                    node.isStatic() ? "static-initializer" : "instance-initializer",
                    qualifiedName,
                    complexity(node),
                    location
                ));
                callables.addLast(qualifiedName);
                try {
                    return super.visitBlock(node, unused);
                } finally {
                    callables.removeLast();
                }
            } catch (ProtocolFailure failure) {
                throw new IllegalStateException(failure);
            }
        }
    }

    public static void main(String[] args) {
        try {
            if (args.length != 3 || !SOURCE_HASH.matcher(args[1]).matches()) {
                throw new ProtocolFailure("usage: JavaAstAnalyzer.java --probe|--analyze sha256:<source-hash>");
            }
            if (args[0].equals("--probe")) {
                System.out.print(runtimeIdentity(args[1], args[2]));
                return;
            }
            if (!args[0].equals("--analyze")) throw new ProtocolFailure("unsupported mode");
            if (!directProcessExecutable(args[2])) throw new ProtocolFailure("configured java executable does not own the analyzer process");
            Request request = decodeRequest(readBoundedInput());
            List<FileResult> results = new ArrayList<>();
            for (InputFile file : request.files()) results.add(analyze(file));
            writeResponse(request, results, args[1]);
        } catch (ProtocolFailure failure) {
            System.err.print("FAIL-JAVA-AST-PROTOCOL: " + bounded(failure.getMessage()));
            System.exit(2);
        } catch (Throwable failure) {
            System.err.print("FAIL-JAVA-AST-PROCESS: " + bounded(failure.getClass().getSimpleName() + ": " + failure.getMessage()));
            System.exit(3);
        }
    }

    private static String bounded(String value) {
        if (value == null || value.isBlank()) return "unspecified analyzer failure";
        String singleLine = value.replace('\r', ' ').replace('\n', ' ');
        return singleLine.substring(0, Math.min(singleLine.length(), 512));
    }

    private static byte[] readBoundedInput() throws IOException, ProtocolFailure {
        int maximum = HARD_MAX_METADATA_BYTES + HARD_MAX_BATCH_BYTES;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        while (true) {
            int read = System.in.read(buffer);
            if (read < 0) break;
            total += read;
            if (total > maximum) throw new ProtocolFailure("request exceeded the hard frame limit");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static Request decodeRequest(byte[] frame) throws IOException, ProtocolFailure {
        DataInputStream input = new DataInputStream(new ByteArrayInputStream(frame));
        byte[] magic = input.readNBytes(REQUEST_MAGIC.length);
        if (!MessageDigest.isEqual(magic, REQUEST_MAGIC)) throw new ProtocolFailure("request magic is invalid");
        int requestIdLength = input.readUnsignedShort();
        String requestId = decodeUtf8(input.readNBytes(requestIdLength));
        if (!REQUEST_ID.matcher(requestId).matches()) throw new ProtocolFailure("request identity is invalid");
        byte[] indexDigestBytes = input.readNBytes(32);
        if (indexDigestBytes.length != 32) throw new ProtocolFailure("index digest is truncated");
        String indexDigest = "sha256:" + HEX.formatHex(indexDigestBytes);
        int grammarTarget = input.readUnsignedShort();
        if (grammarTarget != GRAMMAR_TARGET) throw new ProtocolFailure("grammar target is unsupported");
        long maxFileBytes = Integer.toUnsignedLong(input.readInt());
        int fileCount = input.readUnsignedShort();
        long maxBatchBytes = Integer.toUnsignedLong(input.readInt());
        if (maxFileBytes < 1 || maxFileBytes > HARD_MAX_FILE_BYTES || maxBatchBytes < maxFileBytes || maxBatchBytes > HARD_MAX_BATCH_BYTES) {
            throw new ProtocolFailure("request limits exceed the analyzer contract");
        }
        if (fileCount < 1 || fileCount > HARD_MAX_BATCH_FILES) throw new ProtocolFailure("file count exceeds the analyzer contract");
        record Metadata(int ordinal, int algorithm, byte[] oid, String contentKey, int byteLength, byte[] sha256) {}
        List<Metadata> metadata = new ArrayList<>();
        long totalBytes = 0;
        for (int expectedOrdinal = 0; expectedOrdinal < fileCount; expectedOrdinal++) {
            int ordinal = input.readUnsignedShort();
            if (ordinal != expectedOrdinal) throw new ProtocolFailure("file ordinals are not contiguous");
            int algorithm = input.readUnsignedByte();
            int oidBytes = algorithm == 1 ? 20 : algorithm == 2 ? 32 : 0;
            if (oidBytes == 0) throw new ProtocolFailure("blob object format is invalid");
            byte[] oid = input.readNBytes(oidBytes);
            if (oid.length != oidBytes) throw new ProtocolFailure("blob identity is truncated");
            int contentKeyLength = input.readUnsignedShort();
            String contentKey = decodeUtf8(input.readNBytes(contentKeyLength));
            String expectedContentKey = "git-blob:" + (algorithm == 1 ? "sha1:" : "sha256:") + HEX.formatHex(oid);
            if (!contentKey.equals(expectedContentKey)) throw new ProtocolFailure("content key does not bind the blob identity");
            long unsignedLength = Integer.toUnsignedLong(input.readInt());
            if (unsignedLength > maxFileBytes || unsignedLength > Integer.MAX_VALUE) throw new ProtocolFailure("file exceeds the admitted byte limit");
            byte[] digest = input.readNBytes(32);
            if (digest.length != 32) throw new ProtocolFailure("file digest is truncated");
            totalBytes += unsignedLength;
            if (totalBytes > maxBatchBytes) throw new ProtocolFailure("batch exceeds the admitted byte limit");
            metadata.add(new Metadata(ordinal, algorithm, oid, contentKey, (int) unsignedLength, digest));
        }
        List<InputFile> files = new ArrayList<>();
        for (Metadata item : metadata) {
            byte[] bytes = input.readNBytes(item.byteLength());
            if (bytes.length != item.byteLength()) throw new ProtocolFailure("source bytes are truncated");
            byte[] actual = digest(bytes);
            if (!MessageDigest.isEqual(actual, item.sha256())) throw new ProtocolFailure("source digest does not match request metadata");
            if (!MessageDigest.isEqual(gitBlobDigest(bytes, item.algorithm()), item.oid())) {
                throw new ProtocolFailure("source bytes do not match the Git blob identity");
            }
            files.add(new InputFile(item.ordinal(), item.contentKey(), bytes, HEX.formatHex(actual)));
        }
        if (input.read() != -1) throw new ProtocolFailure("request contains trailing bytes");
        return new Request(requestId, indexDigest, List.copyOf(files));
    }

    private static String decodeUtf8(byte[] bytes) throws ProtocolFailure {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException failure) {
            throw new ProtocolFailure("request metadata is not UTF-8");
        }
    }

    private static byte[] digest(byte[] bytes) throws ProtocolFailure {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (NoSuchAlgorithmException failure) {
            throw new ProtocolFailure("SHA-256 is unavailable");
        }
    }

    private static byte[] gitBlobDigest(byte[] bytes, int algorithm) throws ProtocolFailure {
        try {
            MessageDigest digest = MessageDigest.getInstance(algorithm == 1 ? "SHA-1" : "SHA-256");
            digest.update(("blob " + bytes.length + "\0").getBytes(StandardCharsets.UTF_8));
            return digest.digest(bytes);
        } catch (NoSuchAlgorithmException failure) {
            throw new ProtocolFailure("Git object digest algorithm is unavailable");
        }
    }

    private static FileResult analyze(InputFile file) {
        String source;
        try {
            source = decodeUtf8(file.bytes());
        } catch (ProtocolFailure failure) {
            return error(file, new ParseError("FAIL-JAVA-AST-ENCODING", null, null, null));
        }
        if (source.startsWith("\uFEFF")) source = source.substring(1);
        if (source.indexOf('\0') >= 0) return error(file, new ParseError("FAIL-JAVA-AST-SOURCE", null, null, null));
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) return error(file, new ParseError("FAIL-JAVA-AST-SOURCE", null, null, null));
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        InMemorySource sourceObject = new InMemorySource(file.ordinal(), source);
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(
                null,
                manager,
                diagnostics,
                List.of("-proc:none", "-Xlint:none", "--source", Integer.toString(GRAMMAR_TARGET)),
                null,
                List.of(sourceObject)
            );
            List<CompilationUnitTree> units = new ArrayList<>();
            task.parse().forEach(units::add);
            List<Diagnostic<? extends JavaFileObject>> errors = diagnostics.getDiagnostics().stream()
                .filter(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR)
                .sorted(Comparator
                    .comparingLong((Diagnostic<? extends JavaFileObject> diagnostic) -> diagnostic.getPosition() < 0 ? Long.MAX_VALUE : diagnostic.getPosition())
                    .thenComparing(Diagnostic::getCode))
                .toList();
            if (!errors.isEmpty()) {
                Diagnostic<? extends JavaFileObject> first = errors.getFirst();
                return error(file, new ParseError(
                    "FAIL-JAVA-AST-PARSE",
                    first.getLineNumber() < 1 ? null : first.getLineNumber(),
                    first.getColumnNumber() < 1 ? null : first.getColumnNumber(),
                    first.getCode()
                ));
            }
            if (units.size() != 1) return error(file, new ParseError("FAIL-JAVA-AST-SOURCE", null, null, null));
            CompilationUnitTree unit = units.getFirst();
            Trees trees = Trees.instance(task);
            FactCollector collector = new FactCollector(unit, trees.getSourcePositions());
            collector.scan(unit, null);
            List<CallableFact> callables = new ArrayList<>(collector.callables());
            callables.sort(Comparator
                .comparingInt((CallableFact fact) -> fact.span().startOffset())
                .thenComparingInt(fact -> fact.span().endOffset())
                .thenComparing(CallableFact::kind)
                .thenComparing(CallableFact::qualifiedName));
            List<ImportFact> imports = new ArrayList<>();
            for (ImportTree importTree : unit.getImports()) {
                Span span = span(unit, trees.getSourcePositions(), importTree);
                String qualifiedName = importTree.getQualifiedIdentifier().toString();
                imports.add(new ImportFact(qualifiedName, importTree.isStatic(), qualifiedName.endsWith(".*"), span));
            }
            imports.sort(Comparator
                .comparingInt((ImportFact fact) -> fact.span().startOffset())
                .thenComparingInt(fact -> fact.span().endOffset())
                .thenComparing(ImportFact::qualifiedName));
            String packageName = unit.getPackageName() == null ? null : unit.getPackageName().toString();
            return new FileResult(file.ordinal(), file.contentKey(), file.sha256(), "ok", packageName, List.copyOf(callables), List.copyOf(imports), null);
        } catch (IllegalStateException failure) {
            return error(file, new ParseError("FAIL-JAVA-AST-SOURCE", null, null, null));
        } catch (IOException | ProtocolFailure failure) {
            return error(file, new ParseError("FAIL-JAVA-AST-SOURCE", null, null, null));
        }
    }

    private static Span span(CompilationUnitTree unit, SourcePositions positions, Tree tree) throws ProtocolFailure {
        LineMap lines = unit.getLineMap();
        long start = positions.getStartPosition(unit, tree);
        long end = positions.getEndPosition(unit, tree);
        if (lines == null || start < 0 || end <= start || start > Integer.MAX_VALUE || end > Integer.MAX_VALUE) {
            throw new ProtocolFailure("compiler AST exposed an invalid source position");
        }
        long inclusiveEnd = end - 1;
        return new Span(
            (int) start,
            (int) end,
            lines.getLineNumber(start),
            lines.getColumnNumber(start),
            lines.getLineNumber(inclusiveEnd),
            lines.getColumnNumber(inclusiveEnd) + 1
        );
    }

    private static FileResult error(InputFile file, ParseError error) {
        return new FileResult(file.ordinal(), file.contentKey(), file.sha256(), "error", null, null, null, error);
    }

    private static boolean directProcessExecutable(String configuredExecutable) throws ProtocolFailure {
        try {
            String running = ProcessHandle.current().info().command()
                .orElseThrow(() -> new ProtocolFailure("runtime did not expose its process executable"));
            return Path.of(configuredExecutable).toRealPath().equals(Path.of(running).toRealPath());
        } catch (IOException | RuntimeException failure) {
            throw new ProtocolFailure("could not bind the configured java executable to the runtime process");
        }
    }

    private static String runtimeIdentity(String analyzerHash, String configuredExecutable) throws ProtocolFailure {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null || Runtime.version().feature() < GRAMMAR_TARGET) {
            throw new ProtocolFailure("JDK compiler capability 25 or newer is unavailable");
        }
        return "{"
            + "\"analyzer_source_sha256\":" + quote(analyzerHash)
            + ",\"analyzer_version\":" + quote(ANALYZER_VERSION)
            + ",\"compiler_implementation\":" + quote(compiler.getClass().getName())
            + ",\"direct_process_executable\":" + directProcessExecutable(configuredExecutable)
            + ",\"grammar_target\":" + GRAMMAR_TARGET
            + ",\"java_runtime_version\":" + quote(System.getProperty("java.runtime.version"))
            + ",\"java_vendor\":" + quote(System.getProperty("java.vendor"))
            + ",\"parser_runtime\":" + quote(PARSER_RUNTIME)
            + ",\"protocol\":" + quote(PROTOCOL)
            + "}";
    }

    private static void writeResponse(Request request, List<FileResult> results, String analyzerHash) throws IOException, ProtocolFailure {
        int failures = (int) results.stream().filter(result -> result.status().equals("error")).count();
        String status = failures == 0 ? "ok" : failures == results.size() ? "error" : "partial";
        StringBuilder json = new StringBuilder();
        json.append('{')
            .append("\"analyzer_source_sha256\":").append(quote(analyzerHash))
            .append(",\"analyzer_version\":").append(quote(ANALYZER_VERSION))
            .append(",\"compiler_implementation\":").append(quote(ToolProvider.getSystemJavaCompiler().getClass().getName()))
            .append(",\"diagnostics\":{")
            .append("\"files_failed\":").append(failures)
            .append(",\"files_received\":").append(results.size())
            .append(",\"files_succeeded\":").append(results.size() - failures)
            .append('}')
            .append(",\"direct_process_executable\":true")
            .append(",\"grammar_target\":").append(GRAMMAR_TARGET)
            .append(",\"index_digest\":").append(quote(request.indexDigest()))
            .append(",\"java_runtime_version\":").append(quote(System.getProperty("java.runtime.version")))
            .append(",\"java_vendor\":").append(quote(System.getProperty("java.vendor")))
            .append(",\"parser_runtime\":").append(quote(PARSER_RUNTIME))
            .append(",\"protocol\":").append(quote(PROTOCOL))
            .append(",\"request_id\":").append(quote(request.requestId()))
            .append(",\"results\":[");
        for (int index = 0; index < results.size(); index++) {
            if (index > 0) json.append(',');
            appendResult(json, results.get(index));
        }
        json.append(']')
            .append(",\"status\":").append(quote(status))
            .append('}');
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        DataOutputStream output = new DataOutputStream(System.out);
        output.write(RESPONSE_MAGIC);
        output.writeInt(body.length);
        output.write(body);
        output.flush();
    }

    private static void appendResult(StringBuilder json, FileResult result) {
        json.append('{');
        if (result.status().equals("ok")) {
            json.append("\"callables\":[");
            for (int index = 0; index < result.callables().size(); index++) {
                if (index > 0) json.append(',');
                appendCallable(json, result.callables().get(index));
            }
            json.append(']')
                .append(",\"content_key\":").append(quote(result.contentKey()))
                .append(",\"imports\":[");
            for (int index = 0; index < result.imports().size(); index++) {
                if (index > 0) json.append(',');
                appendImport(json, result.imports().get(index));
            }
            json.append(']')
                .append(",\"ordinal\":").append(result.ordinal())
                .append(",\"package_name\":").append(result.packageName() == null ? "null" : quote(result.packageName()))
                .append(",\"sha256\":").append(quote(result.sha256()))
                .append(",\"status\":\"ok\"");
        } else {
            json.append("\"content_key\":").append(quote(result.contentKey()))
                .append(",\"error\":{")
                .append("\"code\":").append(quote(result.error().code()))
                .append(",\"column\":").append(result.error().column() == null ? "null" : result.error().column())
                .append(",\"compiler_code\":").append(result.error().compilerCode() == null ? "null" : quote(result.error().compilerCode()))
                .append(",\"line\":").append(result.error().line() == null ? "null" : result.error().line())
                .append('}')
                .append(",\"ordinal\":").append(result.ordinal())
                .append(",\"sha256\":").append(quote(result.sha256()))
                .append(",\"status\":\"error\"");
        }
        json.append('}');
    }

    private static void appendCallable(StringBuilder json, CallableFact fact) {
        Span span = fact.span();
        json.append('{')
            .append("\"complexity\":").append(fact.complexity())
            .append(",\"end_column\":").append(span.endColumn())
            .append(",\"end_line\":").append(span.endLine())
            .append(",\"end_offset\":").append(span.endOffset())
            .append(",\"kind\":").append(quote(fact.kind()))
            .append(",\"qualified_name\":").append(quote(fact.qualifiedName()))
            .append(",\"start_column\":").append(span.startColumn())
            .append(",\"start_line\":").append(span.startLine())
            .append(",\"start_offset\":").append(span.startOffset())
            .append('}');
    }

    private static void appendImport(StringBuilder json, ImportFact fact) {
        Span span = fact.span();
        json.append('{')
            .append("\"end_column\":").append(span.endColumn())
            .append(",\"end_line\":").append(span.endLine())
            .append(",\"end_offset\":").append(span.endOffset())
            .append(",\"qualified_name\":").append(quote(fact.qualifiedName()))
            .append(",\"start_column\":").append(span.startColumn())
            .append(",\"start_line\":").append(span.startLine())
            .append(",\"start_offset\":").append(span.startOffset())
            .append(",\"static\":").append(fact.isStatic())
            .append(",\"wildcard\":").append(fact.wildcard())
            .append('}');
    }

    private static String quote(String value) {
        StringBuilder output = new StringBuilder(value.length() + 2);
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) output.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    else output.append(character);
                }
            }
        }
        return output.append('"').toString();
    }
}
