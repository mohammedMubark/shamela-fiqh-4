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

    /** Candidate names for the field holding a page's book id. */
    private static final String[] BOOK_FIELD_CANDIDATES = { "book_key", "book" };

    /** Resolved once per process; null means the index has no usable book field. */
    private static String bookField;
    private static boolean bookFieldResolved;

    /**
     * Work out which field holds the book id, by evidence rather than by name.
     *
     * Shamela's page documents carry both `book_key` and `book`, and guessing
     * which one to filter on would be the same mistake that made this class
     * walk every hit in the first place. So: read a few documents, and pick the
     * field whose value equals the prefix of that document's own id
     * ("1234-56" → "1234"). If neither matches, scoping falls back to filtering
     * after collection, which is correct but slow — and health can say so.
     */
    private static synchronized String bookField(IndexCache cache) throws IOException {
        if (bookFieldResolved) return bookField;
        bookFieldResolved = true;
        bookField = null;

        DirectoryReader reader = cache.reader(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);
        int max = reader.maxDoc();
        if (max == 0) return null;

        // Sample across the index, not just the first documents: a single
        // segment's worth of one book would not prove anything general.
        int[] probes = { 0, max / 3, (2 * max) / 3, max - 1 };
        Map<String, Integer> agreements = new HashMap<>();

        for (int docId : probes) {
            if (docId < 0 || docId >= max) continue;
            Document d;
            try {
                d = stored.document(docId);
            } catch (Exception e) {
                continue;
            }
            String id = d.get(F_ID);
            if (id == null) continue;
            int dash = id.indexOf('-');
            if (dash <= 0) continue;
            String expected = id.substring(0, dash);
            for (String candidate : BOOK_FIELD_CANDIDATES) {
                String value = d.get(candidate);
                if (value != null && value.equals(expected)) {
                    agreements.merge(candidate, 1, Integer::sum);
                }
            }
        }

        // Require agreement on every document we managed to read.
        int probed = 0;
        for (int docId : probes) if (docId >= 0 && docId < max) probed++;
        for (String candidate : BOOK_FIELD_CANDIDATES) {
            if (agreements.getOrDefault(candidate, 0) == probed && probed > 0) {
                bookField = candidate;
                break;
            }
        }
        return bookField;
    }

    /**
     * Restrict a query to a set of books, at the index level.
     *
     * This is the difference between a search that answers in milliseconds and
     * one that reads every matching document to see which book it came from.
     * With 419 books in scope out of 8,598, post-filtering means walking the
     * whole match set to discard most of it.
     */
    private static Query scoped(IndexCache cache, Query base, List<String> bookIds) throws IOException {
        if (bookIds == null || bookIds.isEmpty()) return base;
        String field = bookField(cache);
        if (field == null) return base; // caller falls back to post-filtering

        List<BytesRef> refs = new ArrayList<>(bookIds.size());
        for (String b : bookIds) refs.add(new BytesRef(b));
        return new BooleanQuery.Builder()
                .add(base, BooleanClause.Occur.MUST)
                .add(new TermInSetQuery(field, refs), BooleanClause.Occur.FILTER)
                .build();
    }

    /** Post-collection scope check, used only when no book field was found. */
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

        Query q = scoped(cache, buildTextQuery(terms, mode), bookIds);
        // True only when the index has no book field and scoping could not be
        // pushed down; then, and only then, hits are filtered after collection.
        boolean postFilter = bookField(cache) == null && bookIds != null && !bookIds.isEmpty();
        java.util.Set<String> scope =
                postFilter ? new java.util.HashSet<>(bookIds) : java.util.Set.of();

        int total = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));

        ScoreDoc after = null;
        if (afterDoc != null && afterDoc >= 0) {
            after = new ScoreDoc(afterDoc, afterScore == null ? 0f : afterScore.floatValue());
        }

        int fetch = limit + 1;
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
                if (id == null) continue;
                if (postFilter && !inScope(id, scope)) continue;
                if (hits.size() >= limit) {
                    hasMore = true;
                    break outer;
                }
                int dash = id.indexOf('-');
                if (dash <= 0) continue;
                Map<String, Object> hit = new LinkedHashMap<>();
                hit.put("book_id", id.substring(0, dash));
                hit.put("page_id", Json.asInt(id.substring(dash + 1), -1));
                hit.put("doc", sd.doc);
                hit.put("score", (double) sd.score);
                hits.add(hit);
            }
            // Without a pushed-down filter a page of results may need several
            // rounds; with one, the first round already holds them.
            if (!postFilter || top.scoreDocs.length < fetch) break;
        }

        envelope.put("total_hits", total);
        envelope.put("hits", hits);
        envelope.put("has_more", hasMore);
        envelope.put("scope_pushed_down", !postFilter);
        return envelope;
    }

    /**
     * Exact per-book hit counts, for the phase-one terrain map.
     *
     * One counting query per book. Counting does not read stored fields or
     * build a result list, so this stays proportional to the number of books
     * asked about — not to the number of matching pages, which on a real
     * library runs to millions.
     */
    public static Map<String, Object> countsByBook(
            IndexCache cache, List<String> terms, List<String> bookIds, String mode) throws IOException {
        if (terms == null || terms.isEmpty()) return Json.obj("counts", List.of());

        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        Query base = buildTextQuery(terms, mode);
        String field = bookField(cache);
        List<Object> out = new ArrayList<>();

        if (field != null && bookIds != null && !bookIds.isEmpty()) {
            for (String bookId : bookIds) {
                Query q = new BooleanQuery.Builder()
                        .add(base, BooleanClause.Occur.MUST)
                        .add(new TermQuery(new Term(field, bookId)), BooleanClause.Occur.FILTER)
                        .build();
                int n = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));
                if (n > 0) out.add(Json.obj("book_id", bookId, "hits", n));
            }
            out.sort((a, b) -> Integer.compare(
                    Json.asInt(Json.asObject(b).get("hits"), 0),
                    Json.asInt(Json.asObject(a).get("hits"), 0)));
            return Json.obj("counts", out);
        }

        // No book field, or no scope given: fall back to grouping by walking the
        // matches. Bounded so a broad query cannot run away with the session.
        StoredFields stored = cache.storedFields(IndexCache.PAGE);
        java.util.Set<String> scope = new java.util.HashSet<>(bookIds == null ? List.of() : bookIds);
        Map<String, Integer> counts = new LinkedHashMap<>();
        final int BATCH = 5000;
        final int WALK_LIMIT = 200_000;
        int walked = 0;
        boolean truncated = false;
        ScoreDoc last = null;

        while (walked < WALK_LIMIT) {
            TopDocs top = last == null ? searcher.search(base, BATCH) : searcher.searchAfter(last, base, BATCH);
            if (top.scoreDocs.length == 0) break;
            for (ScoreDoc sd : top.scoreDocs) {
                last = sd;
                walked++;
                String id = stored.document(sd.doc).get(F_ID);
                if (id == null || !inScope(id, scope)) continue;
                int dash = id.indexOf('-');
                if (dash > 0) counts.merge(id.substring(0, dash), 1, Integer::sum);
            }
            if (top.scoreDocs.length < BATCH) break;
            if (walked >= WALK_LIMIT) truncated = true;
        }

        counts.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .forEach(e -> out.add(Json.obj("book_id", e.getKey(), "hits", e.getValue())));
        Map<String, Object> res = Json.obj("counts", out);
        if (truncated) res.put("truncated", Boolean.TRUE);
        return res;
    }

    /** Matching page ids within one book, in page order. */
    public static Map<String, Object> pageIdsForBook(
            IndexCache cache, List<String> terms, String bookId, String mode, int limit)
            throws IOException {
        if (terms == null || terms.isEmpty()) return Json.obj("page_ids", List.of());
        IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
        StoredFields stored = cache.storedFields(IndexCache.PAGE);

        Query q = scoped(cache, buildTextQuery(terms, mode), List.of(bookId));
        boolean postFilter = bookField(cache) == null;

        List<Integer> ids = new ArrayList<>();
        ScoreDoc last = null;
        final int BATCH = Math.max(limit, 200);
        // Bounded even in the fallback: one book's pages are what we want, not
        // an unbounded walk of the whole match set.
        final int WALK_LIMIT = 50_000;
        int walked = 0;

        while (ids.size() < limit && walked < WALK_LIMIT) {
            TopDocs top = last == null ? searcher.search(q, BATCH) : searcher.searchAfter(last, q, BATCH);
            if (top.scoreDocs.length == 0) break;
            for (ScoreDoc sd : top.scoreDocs) {
                last = sd;
                walked++;
                String id = stored.document(sd.doc).get(F_ID);
                if (id == null) continue;
                int dash = id.indexOf('-');
                if (dash <= 0) continue;
                if (postFilter && !id.substring(0, dash).equals(bookId)) continue;
                ids.add(Json.asInt(id.substring(dash + 1), -1));
                if (ids.size() >= limit) break;
            }
            if (top.scoreDocs.length < BATCH) break;
        }
        ids.sort(Integer::compare);
        return Json.obj("page_ids", ids);
    }

    /** Which field scoping uses, for diagnostics. */
    public static String resolvedBookField(IndexCache cache) throws IOException {
        return bookField(cache);
    }
}
