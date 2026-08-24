package dev.shamela.fiqh4;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.core.WhitespaceAnalyzer;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.IntPoint;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.StringField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.PhraseQuery;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;
import org.apache.lucene.search.TotalHitCountCollectorManager;
import org.apache.lucene.store.Directory;
import org.apache.lucene.store.FSDirectory;

/**
 * Optional Lucene backend for shamela-fiqh-4.
 *
 * <p>Speaks newline-delimited JSON on stdin/stdout — a local pipe, never a
 * socket. The extension works without this process; it exists purely to make
 * deep paging over a large corpus cheaper, using Lucene's {@code searchAfter}
 * to resume from a {@link ScoreDoc} instead of re-collecting everything before
 * the requested page.
 *
 * <p>Crucially, this class does <em>no</em> Arabic normalisation. Node has
 * already normalised both the indexed text and the query terms with its
 * versioned normaliser, and running a second, subtly different analyzer chain
 * here would make the two backends disagree about what a query means. So the
 * analyzer is {@link WhitespaceAnalyzer}: split on spaces, change nothing.
 */
public final class Bridge {

  private static final String F_BOOK = "book_id";
  private static final String F_PAGE = "page_id";
  private static final String F_TEXT = "text_search";
  private static final String F_PART = "part";
  private static final String F_PRINTED = "printed_page";

  private static final Analyzer ANALYZER = new WhitespaceAnalyzer();

  private final Map<String, DirectoryReader> readers = new HashMap<>();

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    Bridge bridge = new Bridge();

    String line;
    while ((line = in.readLine()) != null) {
      line = line.trim();
      if (line.isEmpty()) continue;
      Map<String, Object> req;
      long id = 0;
      try {
        req = Json.parseObject(line);
        Object rawId = req.get("id");
        id = rawId instanceof Number ? ((Number) rawId).longValue() : 0;
        String cmd = String.valueOf(req.get("cmd"));
        if ("close".equals(cmd)) {
          bridge.closeAll();
          out.println(Json.ok(id, Map.of("closed", Boolean.TRUE)));
          break;
        }
        Object result = bridge.dispatch(cmd, req);
        out.println(Json.ok(id, result));
      } catch (Exception e) {
        String message = e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage());
        out.println(Json.error(id, message));
      }
    }
    bridge.closeAll();
  }

  private Object dispatch(String cmd, Map<String, Object> req) throws IOException {
    switch (cmd) {
      case "health": return health(req);
      case "inspect": return inspect(req);
      case "index": return index(req);
      case "search": return search(req);
      case "counts": return counts(req);
      case "pages": return pages(req);
      default: throw new IllegalArgumentException("unknown command: " + cmd);
    }
  }

  // ── health ────────────────────────────────────────────────────────────────

  private Object health(Map<String, Object> req) throws IOException {
    Path dir = dirOf(req);
    Map<String, Object> result = new HashMap<>();
    result.put("lucene_version", org.apache.lucene.util.Version.LATEST.toString());
    result.put("java_version", System.getProperty("java.version"));
    result.put("index_dir", dir.toString());

    List<Object> books = new ArrayList<>();
    long generation = 0;
    DirectoryReader reader = openReader(dir);
    if (reader != null) {
      Map<String, int[]> perBook = new HashMap<>();
      StoredFields stored = reader.storedFields();
      for (int i = 0; i < reader.maxDoc(); i++) {
        Document d = stored.document(i);
        String book = d.get(F_BOOK);
        if (book == null) continue;
        perBook.computeIfAbsent(book, k -> new int[1])[0]++;
      }
      for (Map.Entry<String, int[]> e : perBook.entrySet()) {
        Map<String, Object> b = new HashMap<>();
        b.put("book_id", e.getKey());
        b.put("page_count", e.getValue()[0]);
        b.put("indexed_at", String.valueOf(reader.getVersion()));
        books.add(b);
      }
      generation = reader.getVersion();
      result.put("num_docs", reader.numDocs());
    } else {
      result.put("num_docs", 0);
    }
    result.put("books", books);
    result.put("generation", String.valueOf(generation));
    return result;
  }

  // ── inspecting an index this project did not create ───────────────────────

  /**
   * Describe an existing Lucene index: how many documents, which codec wrote
   * it, what the fields are called and how each is indexed.
   *
   * This exists for Shamela's own indexes. Shamela 4 stores book text in
   * Lucene under database/store, not in its SQLite files, so reading that index
   * is the only way to reach the text — and doing so safely means knowing its
   * shape first rather than assuming it.
   *
   * Field VALUES are never returned, only their lengths: the caller needs to
   * know which field holds the page body, not what any page says.
   */
  private Object inspect(Map<String, Object> req) throws IOException {
    Path dir = Paths.get(String.valueOf(req.get("indexDir")));
    int sample = Json.asInt(req.get("sample"), 2);

    Map<String, Object> result = new HashMap<>();
    result.put("index_dir", dir.toString());
    result.put("reader_lucene_version", org.apache.lucene.util.Version.LATEST.toString());

    if (!java.nio.file.Files.isDirectory(dir)) {
      result.put("error", "not a directory");
      return result;
    }

    try (Directory directory = FSDirectory.open(dir);
         DirectoryReader reader = DirectoryReader.open(directory)) {

      result.put("num_docs", reader.numDocs());
      result.put("max_doc", reader.maxDoc());
      result.put("deleted_docs", reader.numDeletedDocs());
      result.put("segments", reader.leaves().size());

      List<Object> codecs = new ArrayList<>();
      for (org.apache.lucene.index.LeafReaderContext ctx : reader.leaves()) {
        org.apache.lucene.index.LeafReader lr = ctx.reader();
        if (lr instanceof org.apache.lucene.index.SegmentReader) {
          org.apache.lucene.index.SegmentCommitInfo si =
              ((org.apache.lucene.index.SegmentReader) lr).getSegmentInfo();
          Map<String, Object> c = new HashMap<>();
          c.put("name", si.info.name);
          c.put("codec", si.info.getCodec().getName());
          c.put("docs", si.info.maxDoc());
          c.put("created_by", String.valueOf(si.info.getVersion()));
          codecs.add(c);
          if (codecs.size() >= 5) break;
        }
      }
      result.put("segment_sample", codecs);

      // Field inventory, gathered across every segment.
      Map<String, Map<String, Object>> fields = new java.util.LinkedHashMap<>();
      for (org.apache.lucene.index.LeafReaderContext ctx : reader.leaves()) {
        for (org.apache.lucene.index.FieldInfo fi : ctx.reader().getFieldInfos()) {
          Map<String, Object> f = fields.computeIfAbsent(fi.name, k -> new HashMap<>());
          f.put("name", fi.name);
          f.put("indexed", fi.getIndexOptions() != org.apache.lucene.index.IndexOptions.NONE);
          f.put("index_options", fi.getIndexOptions().toString());
          f.put("doc_values", fi.getDocValuesType().toString());
          f.put("has_vectors", fi.hasTermVectors());
          f.put("point_dimensions", fi.getPointDimensionCount());
          f.put("stored", Boolean.FALSE);
        }
      }

      // Which fields are actually stored, and how big their values are. Read
      // from a few documents; lengths only, never the text.
      StoredFields stored = reader.storedFields();
      List<Object> samples = new ArrayList<>();
      int step = Math.max(1, reader.maxDoc() / Math.max(1, sample + 1));
      for (int i = 0, taken = 0; i < reader.maxDoc() && taken < sample; i += step, taken++) {
        Document d;
        try {
          d = stored.document(i);
        } catch (Exception e) {
          continue;
        }
        Map<String, Object> docInfo = new java.util.LinkedHashMap<>();
        docInfo.put("doc", i);
        List<Object> present = new ArrayList<>();
        for (org.apache.lucene.index.IndexableField f : d.getFields()) {
          Map<String, Object> fi = fields.get(f.name());
          if (fi != null) fi.put("stored", Boolean.TRUE);
          Map<String, Object> entry = new java.util.LinkedHashMap<>();
          entry.put("field", f.name());
          String v = f.stringValue();
          if (v != null) {
            entry.put("type", "string");
            entry.put("length", v.length());
          } else if (f.numericValue() != null) {
            entry.put("type", "numeric");
            // A numeric id is an identifier, not content — safe to show.
            entry.put("value", f.numericValue().longValue());
          } else if (f.binaryValue() != null) {
            entry.put("type", "binary");
            entry.put("length", f.binaryValue().length);
          } else {
            entry.put("type", "unknown");
          }
          present.add(entry);
        }
        docInfo.put("stored_fields", present);
        samples.add(docInfo);
      }

      result.put("fields", new ArrayList<>(fields.values()));
      result.put("sample_docs", samples);
    } catch (Exception e) {
      result.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
    }
    return result;
  }

  // ── indexing ──────────────────────────────────────────────────────────────

  private Object index(Map<String, Object> req) throws IOException {
    Path dir = dirOf(req);
    boolean reset = Boolean.TRUE.equals(req.get("reset"));
    List<Object> docs = Json.asList(req.get("docs"));

    // A writer is opened per batch and closed again: the Node side streams
    // batches, and holding a writer open across calls would keep a lock on the
    // index directory for the whole run.
    IndexWriterConfig cfg = new IndexWriterConfig(ANALYZER);
    cfg.setOpenMode(reset ? IndexWriterConfig.OpenMode.CREATE : IndexWriterConfig.OpenMode.CREATE_OR_APPEND);

    int written = 0;
    try (Directory directory = FSDirectory.open(dir);
         IndexWriter writer = new IndexWriter(directory, cfg)) {
      Set<String> replaced = new HashSet<>();
      for (Object o : docs) {
        Map<String, Object> d = Json.asObject(o);
        String bookId = String.valueOf(d.get("book_id"));
        // First batch for a book replaces whatever was there, so re-indexing a
        // book cannot leave stale pages behind.
        if (!reset && replaced.add(bookId)) {
          writer.deleteDocuments(new Term(F_BOOK, bookId));
        }
        Document doc = new Document();
        doc.add(new StringField(F_BOOK, bookId, Field.Store.YES));
        int pageId = Json.asInt(d.get("page_id"), 0);
        doc.add(new IntPoint(F_PAGE, pageId));
        doc.add(new StoredField(F_PAGE, pageId));
        // Already normalised by Node — indexed verbatim, no second analyzer.
        doc.add(new TextField(F_TEXT, String.valueOf(d.getOrDefault("text_search", "")), Field.Store.NO));
        Object part = d.get("part");
        if (part != null) doc.add(new StoredField(F_PART, String.valueOf(part)));
        Object printed = d.get("printed_page");
        if (printed != null) doc.add(new StoredField(F_PRINTED, Json.asInt(printed, 0)));
        writer.addDocument(doc);
        written++;
      }
      writer.commit();
    }
    invalidate(dir);
    return Map.of("indexed", written);
  }

  // ── query construction ────────────────────────────────────────────────────

  /**
   * Build the query from pre-normalised terms.
   * Mirrors the Node engine's three modes exactly so a query means the same
   * thing whichever backend answers it.
   */
  private Query buildQuery(Map<String, Object> req) {
    String mode = String.valueOf(req.getOrDefault("mode", "all_terms"));
    List<Object> rawTerms = Json.asList(req.get("terms"));
    List<String> terms = new ArrayList<>();
    for (Object t : rawTerms) {
      String s = String.valueOf(t).trim();
      if (!s.isEmpty()) terms.add(s);
    }
    if (terms.isEmpty()) throw new IllegalArgumentException("query has no terms");

    if ("phrase".equals(mode)) {
      PhraseQuery.Builder b = new PhraseQuery.Builder();
      for (String t : terms) b.add(new Term(F_TEXT, t));
      return b.build();
    }

    BooleanClause.Occur occur =
        "any_terms".equals(mode) ? BooleanClause.Occur.SHOULD : BooleanClause.Occur.MUST;
    BooleanQuery.Builder b = new BooleanQuery.Builder();
    for (String t : terms) b.add(new TermQuery(new Term(F_TEXT, t)), occur);
    return b.build();
  }

  /** Restrict to a set of books, when the caller named one. */
  private Query scoped(Query base, Map<String, Object> req) {
    List<Object> bookIds = Json.asList(req.get("bookIds"));
    if (bookIds.isEmpty()) return base;
    BooleanQuery.Builder filter = new BooleanQuery.Builder();
    for (Object b : bookIds) {
      filter.add(new TermQuery(new Term(F_BOOK, String.valueOf(b))), BooleanClause.Occur.SHOULD);
    }
    return new BooleanQuery.Builder()
        .add(base, BooleanClause.Occur.MUST)
        .add(filter.build(), BooleanClause.Occur.FILTER)
        .build();
  }

  // ── search ────────────────────────────────────────────────────────────────

  private Object search(Map<String, Object> req) throws IOException {
    Path dir = dirOf(req);
    DirectoryReader reader = openReader(dir);
    if (reader == null) return Map.of("hits", List.of(), "total_hits", 0, "has_more", Boolean.FALSE);

    IndexSearcher searcher = new IndexSearcher(reader);
    Query query = scoped(buildQuery(req), req);
    int limit = Math.max(1, Json.asInt(req.get("limit"), 50));

    // Exact, not an estimate: the caller is told how much really exists.
    int total = searcher.search(query, new TotalHitCountCollectorManager(searcher.getSlices()));

    // This is why the Lucene backend exists: resume from the previous page's
    // last ScoreDoc rather than re-collecting everything before it.
    ScoreDoc after = null;
    Map<String, Object> afterObj = Json.asObjectOrNull(req.get("after"));
    if (afterObj != null) {
      int doc = Json.asInt(afterObj.get("doc"), -1);
      float score = (float) Json.asDouble(afterObj.get("score"), 0.0);
      if (doc >= 0) after = new ScoreDoc(doc, score);
    }

    TopDocs top = after == null
        ? searcher.search(query, limit + 1)
        : searcher.searchAfter(after, query, limit + 1);

    boolean hasMore = top.scoreDocs.length > limit;
    int returned = Math.min(top.scoreDocs.length, limit);

    List<Object> hits = new ArrayList<>(returned);
    StoredFields stored = reader.storedFields();
    for (int i = 0; i < returned; i++) {
      ScoreDoc sd = top.scoreDocs[i];
      Document d = stored.document(sd.doc);
      Map<String, Object> h = new HashMap<>();
      h.put("book_id", d.get(F_BOOK));
      h.put("page_id", Json.asInt(d.get(F_PAGE), 0));
      h.put("score", (double) sd.score);
      h.put("doc", sd.doc);
      h.put("part", d.get(F_PART));
      String printed = d.get(F_PRINTED);
      h.put("printed_page", printed == null ? null : Integer.valueOf(printed));
      hits.add(h);
    }

    Map<String, Object> result = new HashMap<>();
    result.put("hits", hits);
    result.put("total_hits", total);
    result.put("has_more", hasMore);
    return result;
  }

  // ── aggregates ────────────────────────────────────────────────────────────

  private Object counts(Map<String, Object> req) throws IOException {
    Path dir = dirOf(req);
    DirectoryReader reader = openReader(dir);
    if (reader == null) return Map.of("counts", List.of());

    IndexSearcher searcher = new IndexSearcher(reader);
    Query base = buildQuery(req);
    List<Object> bookIds = Json.asList(req.get("bookIds"));

    List<Object> out = new ArrayList<>();
    if (bookIds.isEmpty()) {
      // No scope given: group by walking the matches once.
      Map<String, int[]> perBook = new HashMap<>();
      TopDocs all = searcher.search(base, Math.max(1, reader.maxDoc()));
      StoredFields stored = reader.storedFields();
      for (ScoreDoc sd : all.scoreDocs) {
        String book = stored.document(sd.doc).get(F_BOOK);
        if (book != null) perBook.computeIfAbsent(book, k -> new int[1])[0]++;
      }
      for (Map.Entry<String, int[]> e : perBook.entrySet()) {
        out.add(Map.of("book_id", e.getKey(), "hits", e.getValue()[0]));
      }
    } else {
      // Scoped: one exact count per book, which avoids materialising hits.
      for (Object b : bookIds) {
        String bookId = String.valueOf(b);
        Query q = new BooleanQuery.Builder()
            .add(base, BooleanClause.Occur.MUST)
            .add(new TermQuery(new Term(F_BOOK, bookId)), BooleanClause.Occur.FILTER)
            .build();
        int n = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));
        if (n > 0) out.add(Map.of("book_id", bookId, "hits", n));
      }
    }
    out.sort((x, y) -> Integer.compare(
        Json.asInt(Json.asObject(y).get("hits"), 0),
        Json.asInt(Json.asObject(x).get("hits"), 0)));
    return Map.of("counts", out);
  }

  private Object pages(Map<String, Object> req) throws IOException {
    Path dir = dirOf(req);
    DirectoryReader reader = openReader(dir);
    if (reader == null) return Map.of("page_ids", List.of());

    IndexSearcher searcher = new IndexSearcher(reader);
    String bookId = String.valueOf(req.get("bookId"));
    int limit = Math.max(1, Json.asInt(req.get("limit"), 20));

    Query q = new BooleanQuery.Builder()
        .add(buildQuery(req), BooleanClause.Occur.MUST)
        .add(new TermQuery(new Term(F_BOOK, bookId)), BooleanClause.Occur.FILTER)
        .build();

    TopDocs top = searcher.search(q, Math.max(limit, 1));
    List<Integer> ids = new ArrayList<>();
    StoredFields stored = reader.storedFields();
    for (ScoreDoc sd : top.scoreDocs) {
      ids.add(Json.asInt(stored.document(sd.doc).get(F_PAGE), 0));
    }
    ids.sort(Integer::compare);
    return Map.of("page_ids", ids);
  }

  // ── reader cache ──────────────────────────────────────────────────────────

  private DirectoryReader openReader(Path dir) throws IOException {
    String key = dir.toString();
    DirectoryReader cached = readers.get(key);
    if (cached != null) {
      DirectoryReader refreshed = DirectoryReader.openIfChanged(cached);
      if (refreshed != null) {
        cached.close();
        readers.put(key, refreshed);
        return refreshed;
      }
      return cached;
    }
    if (!java.nio.file.Files.isDirectory(dir)) return null;
    try {
      DirectoryReader reader = DirectoryReader.open(FSDirectory.open(dir));
      readers.put(key, reader);
      return reader;
    } catch (org.apache.lucene.index.IndexNotFoundException e) {
      return null;
    }
  }

  private void invalidate(Path dir) throws IOException {
    DirectoryReader r = readers.remove(dir.toString());
    if (r != null) r.close();
  }

  private void closeAll() {
    for (DirectoryReader r : readers.values()) {
      try { r.close(); } catch (IOException ignored) { }
    }
    readers.clear();
  }

  private static Path dirOf(Map<String, Object> req) throws IOException {
    Object d = req.get("indexDir");
    if (d == null) throw new IllegalArgumentException("indexDir is required");
    Path p = Paths.get(String.valueOf(d));
    java.nio.file.Files.createDirectories(p);
    return p;
  }
}
