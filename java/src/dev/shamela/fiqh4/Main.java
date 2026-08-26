package dev.shamela.fiqh4;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The Lucene helper for shamela-fiqh-4.
 *
 * Speaks newline-delimited JSON on stdin/stdout — a local pipe to a child
 * process, never a socket and never a port. It is launched with Shamela's own
 * Java runtime and its own Lucene jars on the classpath, so this project ships
 * neither: only the few kilobytes of classes compiled from this directory.
 *
 * Nothing here writes. Every index is opened through a read-only
 * DirectoryReader, so a running Shamela is undisturbed.
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        IndexCache cache = null;
        String line;
        try {
            while ((line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                long id = 0;
                try {
                    Map<String, Object> req = Json.parseObject(line);
                    Object rawId = req.get("id");
                    id = rawId instanceof Number ? ((Number) rawId).longValue() : 0;
                    String cmd = String.valueOf(req.get("cmd"));

                    if ("close".equals(cmd)) {
                        out.println(Json.ok(id, Map.of("closed", Boolean.TRUE)));
                        break;
                    }

                    if (cache == null) {
                        Object store = req.get("storeDir");
                        if (store == null) throw new IllegalArgumentException("storeDir is required");
                        cache = new IndexCache(resolve(String.valueOf(store)));
                    }

                    out.println(Json.ok(id, dispatch(cache, cmd, req)));
                } catch (Exception e) {
                    out.println(Json.error(id, e.getClass().getSimpleName() + ": " + e.getMessage()));
                }
            }
        } finally {
            if (cache != null) cache.close();
        }
    }

    private static Path resolve(String p) {
        return Paths.get(p).toAbsolutePath().normalize();
    }

    private static Object dispatch(IndexCache cache, String cmd, Map<String, Object> req) throws Exception {
        switch (cmd) {
            case "health":
                return Commands.stats(cache);
            case "getPages":
                return Commands.getPages(cache, bookRequests(req, "pageIds"));
            case "getTitles":
                return Commands.getTitles(cache, bookRequests(req, "titleIds"));
            case "search":
                return Commands.searchPages(
                        cache,
                        strings(req.get("terms")),
                        strings(req.get("bookIds")),
                        String.valueOf(req.getOrDefault("mode", "all_terms")),
                        Math.max(1, Json.asInt(req.get("limit"), 50)),
                        req.get("afterDoc") == null ? null : Json.asInt(req.get("afterDoc"), -1),
                        req.get("afterScore") == null ? null : Json.asDouble(req.get("afterScore"), 0.0));
            case "counts":
                return Commands.countsByBook(
                        cache,
                        strings(req.get("terms")),
                        strings(req.get("bookIds")),
                        String.valueOf(req.getOrDefault("mode", "all_terms")));
            case "pages":
                return Commands.pageIdsForBook(
                        cache,
                        strings(req.get("terms")),
                        String.valueOf(req.get("bookId")),
                        String.valueOf(req.getOrDefault("mode", "all_terms")),
                        Math.max(1, Json.asInt(req.get("limit"), 20)));
            case "inspect":
                return Inspect.describe(String.valueOf(req.get("indexDir")), Json.asInt(req.get("sample"), 2));
            default:
                throw new IllegalArgumentException("unknown command: " + cmd);
        }
    }

    /**
     * Read a fetch request in either shape.
     *
     * `{ requests: [{ bookId, ids }] }` resolves a whole batch spanning several
     * books in one query, which is what the pipeline sends. The older single
     * book form — `{ bookId, pageIds }` — is still accepted so a caller holding
     * one book's ids does not have to wrap them.
     */
    private static List<Commands.BookRequest> bookRequests(Map<String, Object> req, String idsKey) {
        List<Commands.BookRequest> out = new ArrayList<>();
        Object batched = req.get("requests");
        if (batched != null) {
            for (Object entry : Json.asList(batched)) {
                Map<String, Object> row = Json.asObject(entry);
                List<Integer> ids = ints(row.get("ids"));
                if (!ids.isEmpty()) out.add(new Commands.BookRequest(Json.asInt(row.get("bookId"), -1), ids));
            }
            return out;
        }
        List<Integer> ids = ints(req.get(idsKey));
        if (!ids.isEmpty()) out.add(new Commands.BookRequest(Json.asInt(req.get("bookId"), -1), ids));
        return out;
    }

    private static List<Integer> ints(Object v) {
        List<Integer> out = new ArrayList<>();
        for (Object o : Json.asList(v)) out.add(Json.asInt(o, -1));
        return out;
    }

    private static List<String> strings(Object v) {
        List<String> out = new ArrayList<>();
        for (Object o : Json.asList(v)) {
            String s = String.valueOf(o).trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }
}
