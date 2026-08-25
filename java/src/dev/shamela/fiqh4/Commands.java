package dev.shamela.fiqh4;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.PhraseQuery;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TermInSetQuery;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;
import org.apache.lucene.search.TotalHitCountCollectorManager;
import org.apache.lucene.util.BytesRef;

/**
 * Every Lucene read the extension performs against Shamela's own indexes.
 *
 * Documents in {@code store/page} are keyed {@code "<book_id>-<page_id>"} and
 * store {@code body} (the page text) and {@code foot} (the editor's footnote).
 * {@code store/title} is keyed the same way and stores heading text in
 * {@code body}. Nothing here writes.
 *
 * Query terms arrive already folded by the Node side, using the same rules
 * Shamela's analyzer applied at index time. Folding them here as well would
 * risk the two drifting apart, so this class treats them as exact terms.
 */
public final class Commands {

    private Commands() {}

    private static final String F_ID = "id";
    private static final String F_BODY = "body";
    private static final String F_FOOT = "foot";
    private static final String F_PARENT = "parent";

    // ── health ───────────────────────────────────────────────────────────────

    public static Map<String, Object> stats(IndexCache cache) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("java_version", System.getProperty("java.version"));
        out.put("lucene_version", org.apache.lucene.util.Version.LATEST.toString());
        for (String idx : new String[] { IndexCache.PAGE, IndexCache.TITLE }) {
            int docs = -1;
            String generation = null;
            try {
                if (cache.exists(idx)) {
                    DirectoryReader r = cache.reader(idx);
                    docs = r.numDocs();
                    // Part of the fingerprint cursors bind to: it changes
                    // whenever Shamela rewrites the index.
                    generation = String.valueOf(r.getVersion());
                }
            } catch (IOException e) {
                docs = -1;
            }
            out.put(idx + "_docs", docs);
            out.put(idx + "_generation", generation);
        }
        return out;
    }

    // ── fetching known pages ─────────────────────────────────────────────────

    /** Stored body and footnote for specific pages of one book. */
    public static Map<String, Object> getPages(IndexCache cache, int bookId, List<Integer> pageIds)
            throws IOException {
        List<Map<String, Object>> results = new ArrayList<>();
        if (pageIds == null || pageIds.isEmpty()) {
            return Json.obj("book_id", bookId, "results", results);
        }
        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);

        List<BytesRef> refs = new ArrayList<>(pageIds.size());
        for (Integer pid : pageIds) refs.add(new BytesRef(bookId + "-" + pid));
        Query q = refs.size() == 1
                ? new TermQuery(new Term(F_ID, refs.get(0)))
                : new TermInSetQuery(F_ID, refs);
        TopDocs top = searcher.search(q, Math.max(1, pageIds.size()));

        Map<String, Document> byKey = new HashMap<>();
        for (ScoreDoc sd : top.scoreDocs) {
            Document d = stored.document(sd.doc);
            String id = d.get(F_ID);
            if (id != null) byKey.put(id, d);
        }
        // Answer in the order asked, marking misses rather than dropping them.
        for (Integer pid : pageIds) {
            Document d = byKey.get(bookId + "-" + pid);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("page_id", pid);
            row.put("found", d != null);
            row.put("body", d == null ? null : d.get(F_BODY));
            row.put("foot", d == null ? null : d.get(F_FOOT));
            results.add(row);
        }
        return Json.obj("book_id", bookId, "results", results);
    }

    /** Heading entries for one book, so a page can be placed in its chapter. */
    public static Map<String, Object> getTitles(IndexCache cache, int bookId, List<Integer> titleIds)
            throws IOException {
        List<Map<String, Object>> results = new ArrayList<>();
        if (titleIds == null || titleIds.isEmpty()) {
            return Json.obj("book_id", bookId, "results", results);
        }
        IndexSearcher searcher = cache.searcher(IndexCache.TITLE);
        StoredFields stored = cache.storedFields(IndexCache.TITLE);

        List<BytesRef> refs = new ArrayList<>(titleIds.size());
        for (Integer tid : titleIds) refs.add(new BytesRef(bookId + "-" + tid));
        Query q = refs.size() == 1
                ? new TermQuery(new Term(F_ID, refs.get(0)))
                : new TermInSetQuery(F_ID, refs);
        TopDocs top = searcher.search(q, Math.max(1, titleIds.size()));

        Map<String, Document> byKey = new HashMap<>();
        for (ScoreDoc sd : top.scoreDocs) {
            Document d = stored.document(sd.doc);
            String id = d.get(F_ID);
            if (id != null) byKey.put(id, d);
        }
        for (Integer tid : titleIds) {
            Document d = byKey.get(bookId + "-" + tid);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("title_id", tid);
            row.put("found", d != null);
            row.put("body", d == null ? null : d.get(F_BODY));
            row.put("parent", d == null ? null : d.get(F_PARENT));
            results.add(row);
        }
        return Json.obj("book_id", bookId, "results", results);
    }

    // ── searching ────────────────────────────────────────────────────────────

    /** Build the query from pre-folded terms, mirroring the Node engine's modes. */
    private static Query buildTextQuery(List<String> terms, String mode) {
        if ("phrase".equals(mode)) {
            PhraseQuery.Builder b = new PhraseQuery.Builder();
            for (String t : terms) b.add(new Term(F_BODY, t));
            return b.build();
        }
        BooleanClause.Occur occur =
                "any_terms".equals(mode) ? BooleanClause.Occur.SHOULD : BooleanClause.Occur.MUST;
        BooleanQuery.Builder b = new BooleanQuery.Builder();
        for (String t : terms) b.add(new TermQuery(new Term(F_BODY, t)), occur);
        return b.build();
    }

    /**
     * Restrict to a set of books.
     *
     * Shamela's page ids are {@code "<book>-<page>"} strings with no separate
     * book field, so scoping is done on our side by filtering the returned ids
     * rather than with a Lucene filter. Callers pass the scope so hits outside
     * it never reach the user.
     */
    private static boolean inScope(String id, java.util.Set<String> books) {
        if (books.isEmpty()) return true;
        int dash = id.indexOf('-');
        return dash > 0 && books.contains(id.substring(0, dash));
    }

    /**
     * One page of results, resuming from the previous page's last hit.
     *
     * `searchAfter` is the point of doing this in Lucene: reaching result
     * 50,000 costs the same as reaching result 50, where an offset would make
     * the engine re-collect everything before it on every request.
     */
    public static Map<String, Object> searchPages(
            IndexCache cache,
            List<String> terms,
            List<String> bookIds,
            String mode,
            int limit,
            Integer afterDoc,
            Double afterScore
    ) throws IOException {
        Map<String, Object> envelope = new LinkedHashMap<>();
        if (terms == null || terms.isEmpty()) {
            envelope.put("total_hits", 0);
            envelope.put("hits", List.of());
            envelope.put("has_more", Boolean.FALSE);
            return envelope;
        }

        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);
        java.util.Set<String> scope = new java.util.HashSet<>(bookIds == null ? List.of() : bookIds);

        Query q = buildTextQuery(terms, mode);
        int total = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));

        ScoreDoc after = null;
        if (afterDoc != null && afterDoc >= 0) {
            after = new ScoreDoc(afterDoc, afterScore == null ? 0f : afterScore.floatValue());
        }

        // Scope filtering happens after collection, so over-fetch when a scope
        // is set: a page of 20 in-scope hits may need several hundred raw hits.
        int fetch = scope.isEmpty() ? limit + 1 : Math.min(10_000, Math.max(limit * 20, 200));

        List<Object> hits = new ArrayList<>();
        boolean hasMore = false;
        ScoreDoc last = after;

        outer:
        while (true) {
            TopDocs top = last == null ? searcher.search(q, fetch) : searcher.searchAfter(last, q, fetch);
            if (top.scoreDocs.length == 0) break;

            for (ScoreDoc sd : top.scoreDocs) {
                last = sd;
                Document d = stored.document(sd.doc);
                String id = d.get(F_ID);
                if (id == null || !inScope(id, scope)) continue;
                if (hits.size() >= limit) {
                    hasMore = true;
                    break outer;
                }
                int dash = id.indexOf('-');
                Map<String, Object> hit = new LinkedHashMap<>();
                hit.put("book_id", id.substring(0, dash));
                hit.put("page_id", Json.asInt(id.substring(dash + 1), -1));
                hit.put("doc", sd.doc);
                hit.put("score", (double) sd.score);
                hits.add(hit);
            }
            if (top.scoreDocs.length < fetch) break;
        }

        envelope.put("total_hits", total);
        envelope.put("hits", hits);
        envelope.put("has_more", hasMore);
        return envelope;
    }

    /** Exact per-book hit counts, for the phase-one terrain map. */
    public static Map<String, Object> countsByBook(
            IndexCache cache, List<String> terms, List<String> bookIds, String mode) throws IOException {
        Map<String, Integer> counts = new LinkedHashMap<>();
        if (terms == null || terms.isEmpty()) return Json.obj("counts", List.of());

        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);
        java.util.Set<String> scope = new java.util.HashSet<>(bookIds == null ? List.of() : bookIds);

        Query q = buildTextQuery(terms, mode);
        // Walk every match once. The ids carry the book, so one pass gives the
        // full distribution without a query per book.
        ScoreDoc last = null;
        final int BATCH = 5000;
        while (true) {
            TopDocs top = last == null ? searcher.search(q, BATCH) : searcher.searchAfter(last, q, BATCH);
            if (top.scoreDocs.length == 0) break;
            for (ScoreDoc sd : top.scoreDocs) {
                last = sd;
                String id = stored.document(sd.doc).get(F_ID);
                if (id == null || !inScope(id, scope)) continue;
                int dash = id.indexOf('-');
                String book = id.substring(0, dash);
                counts.merge(book, 1, Integer::sum);
            }
            if (top.scoreDocs.length < BATCH) break;
        }

        List<Object> out = new ArrayList<>();
        counts.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .forEach(e -> out.add(Json.obj("book_id", e.getKey(), "hits", e.getValue())));
        return Json.obj("counts", out);
    }

    /** Matching page ids within one book, in page order. */
    public static Map<String, Object> pageIdsForBook(
            IndexCache cache, List<String> terms, String bookId, String mode, int limit)
            throws IOException {
        if (terms == null || terms.isEmpty()) return Json.obj("page_ids", List.of());
        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);

        Query q = buildTextQuery(terms, mode);
        List<Integer> ids = new ArrayList<>();
        ScoreDoc last = null;
        final int BATCH = 2000;
        while (ids.size() < limit) {
            TopDocs top = last == null ? searcher.search(q, BATCH) : searcher.searchAfter(last, q, BATCH);
            if (top.scoreDocs.length == 0) break;
            for (ScoreDoc sd : top.scoreDocs) {
                last = sd;
                String id = stored.document(sd.doc).get(F_ID);
                if (id == null) continue;
                int dash = id.indexOf('-');
                if (dash <= 0 || !id.substring(0, dash).equals(bookId)) continue;
                ids.add(Json.asInt(id.substring(dash + 1), -1));
                if (ids.size() >= limit) break;
            }
            if (top.scoreDocs.length < BATCH) break;
        }
        ids.sort(Integer::compare);
        return Json.obj("page_ids", ids);
    }
}
