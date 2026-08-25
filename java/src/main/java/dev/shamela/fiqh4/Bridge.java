package dev.shamela.fiqh4;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.DirectoryReader;
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

/** Long-lived local bridge that reads Shamela's own Lucene indexes read-only. */
public final class Bridge {
  private static final String F_ID = "id";
  private static final String F_BOOK = "book_key";
  private static final String F_BODY = "body";
  private static final String F_PARENT = "parent";

  private final Path root;
  private final IndexCache cache;

  private Bridge(Path root) {
    this.root = root;
    this.cache = new IndexCache(root);
  }

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    if (args.length < 1) {
      out.println(Json.error(0, "usage: Bridge <shamela_install_root> [parent_pid]"));
      System.exit(2);
      return;
    }

    Bridge bridge = new Bridge(Paths.get(args[0]));
    if (args.length >= 2) watchParent(args[1], bridge.cache);

    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) continue;
      long id = 0;
      try {
        Map<String, Object> req = Json.parseObject(line);
        Object rawId = req.get("id");
        id = rawId instanceof Number ? ((Number) rawId).longValue() : 0;
        String cmd = String.valueOf(req.get("cmd"));
        if ("close".equals(cmd)) {
          bridge.cache.close();
          out.println(Json.ok(id, Map.of("closed", Boolean.TRUE)));
          break;
        }
        out.println(Json.ok(id, bridge.dispatch(cmd, req)));
      } catch (Exception e) {
        out.println(Json.error(id, e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage())));
      }
    }
    bridge.cache.close();
  }

  private Object dispatch(String cmd, Map<String, Object> req) throws Exception {
    return switch (cmd) {
      case "health" -> health();
      case "books" -> books(req);
      case "search" -> search(req);
      case "counts" -> counts(req);
      case "pages" -> pages(req);
      case "get_pages" -> getPages(req);
      case "get_titles" -> getTitles(req);
      default -> throw new IllegalArgumentException("unknown command: " + cmd);
    };
  }

  private Object health() throws Exception {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("java_version", System.getProperty("java.version"));
    out.put("lucene_version", org.apache.lucene.util.Version.LATEST.toString());
    out.put("library_root", root.toString());
    out.put("page_index", root.resolve("database").resolve("store").resolve("page").toString());
    out.put("title_index", root.resolve("database").resolve("store").resolve("title").toString());
    out.put("page_index_exists", cache.exists(IndexCache.PAGE));
    out.put("title_index_exists", cache.exists(IndexCache.TITLE));
    out.put("page_docs", cache.exists(IndexCache.PAGE) ? cache.numDocs(IndexCache.PAGE) : -1);
    out.put("title_docs", cache.exists(IndexCache.TITLE) ? cache.numDocs(IndexCache.TITLE) : -1);
    out.put("page_commit", cache.exists(IndexCache.PAGE) ? cache.commitId(IndexCache.PAGE) : "");
    out.put("title_commit", cache.exists(IndexCache.TITLE) ? cache.commitId(IndexCache.TITLE) : "");
    return out;
  }

  private Object books(Map<String, Object> req) throws Exception {
    DirectoryReader reader = cache.reader(IndexCache.PAGE);
    List<Object> rows = new ArrayList<>();
    String commit = cache.commitId(IndexCache.PAGE);
    for (Object o : Json.asList(req.get("bookIds"))) {
      String id = String.valueOf(o);
      int pages = reader.docFreq(new Term(F_BOOK, id));
      if (pages <= 0) continue;
      Map<String, Object> b = new LinkedHashMap<>();
      b.put("book_id", id);
      b.put("page_count", pages);
      b.put("indexed_at", commit);
      rows.add(b);
    }
    return Map.of("books", rows, "generation", commit);
  }

  private Object search(Map<String, Object> req) throws Exception {
    IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
    Query q = scoped(buildQuery(req, F_BODY), req);
    int limit = Math.max(1, Json.asInt(req.get("limit"), 50));

    int total = -1;
    if (!Boolean.FALSE.equals(req.get("withTotal"))) {
      total = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));
    }

    ScoreDoc after = after(req);
    TopDocs top = after == null ? searcher.search(q, limit + 1) : searcher.searchAfter(after, q, limit + 1);
    boolean hasMore = top.scoreDocs.length > limit;
    int returned = Math.min(top.scoreDocs.length, limit);

    List<Object> hits = new ArrayList<>(returned);
    for (int i = 0; i < returned; i++) {
      ScoreDoc sd = top.scoreDocs[i];
      Document d = cache.stored(IndexCache.PAGE).document(sd.doc);
      PageKey key = pageKey(d);
      if (key == null) continue;
      Map<String, Object> h = new LinkedHashMap<>();
      h.put("book_id", key.bookId);
      h.put("page_id", key.pageId);
      h.put("score", (double) sd.score);
      h.put("doc", sd.doc);
      h.put("part", null);
      h.put("printed_page", null);
      h.put("text_original", nz(d.get(F_BODY)));
      hits.add(h);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("hits", hits);
    out.put("total_hits", total);
    out.put("has_more", hasMore);
    return out;
  }

  private Object counts(Map<String, Object> req) throws Exception {
    IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
    Query base = buildQuery(req, F_BODY);
    List<Object> out = new ArrayList<>();
    for (Object o : Json.asList(req.get("bookIds"))) {
      String bookId = String.valueOf(o);
      Query q = new BooleanQuery.Builder()
          .add(base, BooleanClause.Occur.MUST)
          .add(new TermQuery(new Term(F_BOOK, bookId)), BooleanClause.Occur.FILTER)
          .build();
      int n = searcher.search(q, new TotalHitCountCollectorManager(searcher.getSlices()));
      if (n > 0) out.add(Map.of("book_id", bookId, "hits", n));
    }
    out.sort((a, b) -> Integer.compare(
        Json.asInt(Json.asObject(b).get("hits"), 0),
        Json.asInt(Json.asObject(a).get("hits"), 0)));
    return Map.of("counts", out);
  }

  private Object pages(Map<String, Object> req) throws Exception {
    IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
    String bookId = String.valueOf(req.get("bookId"));
    int limit = Math.max(1, Json.asInt(req.get("limit"), 20));
    Query q = new BooleanQuery.Builder()
        .add(buildQuery(req, F_BODY), BooleanClause.Occur.MUST)
        .add(new TermQuery(new Term(F_BOOK, bookId)), BooleanClause.Occur.FILTER)
        .build();
    TopDocs top = searcher.search(q, limit);
    List<Integer> ids = new ArrayList<>();
    for (ScoreDoc sd : top.scoreDocs) {
      PageKey key = pageKey(cache.stored(IndexCache.PAGE).document(sd.doc));
      if (key != null && bookId.equals(key.bookId)) ids.add(key.pageId);
    }
    ids.sort(Integer::compare);
    return Map.of("page_ids", ids);
  }

  private Object getPages(Map<String, Object> req) throws Exception {
    String bookId = String.valueOf(req.get("bookId"));
    List<Integer> pageIds = intList(req.get("pageIds"));
    IndexSearcher searcher = cache.searcher(IndexCache.PAGE);
    Map<Integer, Document> byPage = new HashMap<>();
    if (!pageIds.isEmpty()) {
      TopDocs top = searcher.search(idQuery(bookId, pageIds), Math.max(1, pageIds.size()));
      for (ScoreDoc sd : top.scoreDocs) {
        Document d = cache.stored(IndexCache.PAGE).document(sd.doc);
        PageKey key = pageKey(d);
        if (key != null && bookId.equals(key.bookId)) byPage.put(key.pageId, d);
      }
    }
    List<Object> rows = new ArrayList<>();
    for (Integer pageId : pageIds) {
      Document d = byPage.get(pageId);
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("page_id", pageId);
      row.put("found", d != null);
      row.put("body", d == null ? "" : nz(d.get(F_BODY)));
      rows.add(row);
    }
    return Map.of("book_id", bookId, "pages", rows);
  }

  private Object getTitles(Map<String, Object> req) throws Exception {
    String bookId = String.valueOf(req.get("bookId"));
    List<Integer> titleIds = intList(req.get("titleIds"));
    if (!cache.exists(IndexCache.TITLE) || titleIds.isEmpty()) return Map.of("book_id", bookId, "titles", List.of());
    IndexSearcher searcher = cache.searcher(IndexCache.TITLE);
    Map<Integer, Document> byId = new HashMap<>();
    TopDocs top = searcher.search(idQuery(bookId, titleIds), Math.max(1, titleIds.size()));
    for (ScoreDoc sd : top.scoreDocs) {
      Document d = cache.stored(IndexCache.TITLE).document(sd.doc);
      Integer id = trailingId(d.get(F_ID));
      if (id != null) byId.put(id, d);
    }
    List<Object> rows = new ArrayList<>();
    for (Integer titleId : titleIds) {
      Document d = byId.get(titleId);
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("title_id", titleId);
      row.put("found", d != null);
      row.put("text", d == null ? "" : nz(d.get(F_BODY)));
      row.put("parent_id", d == null ? null : parseIntOrNull(d.get(F_PARENT)));
      rows.add(row);
    }
    return Map.of("book_id", bookId, "titles", rows);
  }

  private Query buildQuery(Map<String, Object> req, String field) {
    String mode = String.valueOf(req.getOrDefault("mode", "all_terms"));
    List<String> terms = Normalize.normalizeTerms(Json.asList(req.get("terms")));
    if (terms.isEmpty()) throw new IllegalArgumentException("query has no terms");
    if ("phrase".equals(mode)) {
      PhraseQuery.Builder b = new PhraseQuery.Builder();
      for (String t : terms) b.add(new Term(field, t));
      return b.build();
    }
    BooleanClause.Occur occur = "any_terms".equals(mode) ? BooleanClause.Occur.SHOULD : BooleanClause.Occur.MUST;
    BooleanQuery.Builder b = new BooleanQuery.Builder();
    if (occur == BooleanClause.Occur.SHOULD) b.setMinimumNumberShouldMatch(1);
    for (String t : terms) b.add(new TermQuery(new Term(field, t)), occur);
    return b.build();
  }

  private Query scoped(Query base, Map<String, Object> req) {
    List<Object> bookIds = Json.asList(req.get("bookIds"));
    if (bookIds.isEmpty()) return base;
    List<BytesRef> refs = new ArrayList<>(bookIds.size());
    for (Object o : bookIds) refs.add(new BytesRef(String.valueOf(o)));
    return new BooleanQuery.Builder()
        .add(base, BooleanClause.Occur.MUST)
        .add(new TermInSetQuery(F_BOOK, refs), BooleanClause.Occur.FILTER)
        .build();
  }

  private Query idQuery(String bookId, List<Integer> ids) {
    List<BytesRef> refs = new ArrayList<>(ids.size());
    for (Integer id : ids) refs.add(new BytesRef(bookId + "-" + id));
    return refs.size() == 1 ? new TermQuery(new Term(F_ID, refs.get(0))) : new TermInSetQuery(F_ID, refs);
  }

  private ScoreDoc after(Map<String, Object> req) {
    Map<String, Object> obj = Json.asObjectOrNull(req.get("after"));
    if (obj == null) return null;
    int doc = Json.asInt(obj.get("doc"), -1);
    float score = (float) Json.asDouble(obj.get("score"), 0);
    return doc < 0 ? null : new ScoreDoc(doc, score);
  }

  private record PageKey(String bookId, int pageId) {}

  private PageKey pageKey(Document d) {
    String id = d.get(F_ID);
    if (id == null) return null;
    int dash = id.indexOf('-');
    if (dash <= 0 || dash >= id.length() - 1) return null;
    Integer page = parseIntOrNull(id.substring(dash + 1));
    return page == null ? null : new PageKey(id.substring(0, dash), page);
  }

  private Integer trailingId(String key) {
    if (key == null) return null;
    int dash = key.indexOf('-');
    return dash < 0 ? parseIntOrNull(key) : parseIntOrNull(key.substring(dash + 1));
  }

  private static List<Integer> intList(Object o) {
    List<Integer> out = new ArrayList<>();
    for (Object e : Json.asList(o)) {
      Integer n = parseIntOrNull(String.valueOf(e));
      if (n != null) out.add(n);
    }
    out.sort(Comparator.naturalOrder());
    return out;
  }

  private static Integer parseIntOrNull(String s) {
    if (s == null) return null;
    try { return Integer.valueOf(s.trim()); } catch (NumberFormatException e) { return null; }
  }

  private static String nz(String s) {
    return s == null ? "" : s;
  }

  private static void watchParent(String parentPid, IndexCache cache) {
    long pid;
    try { pid = Long.parseLong(parentPid.trim()); } catch (NumberFormatException e) { return; }
    Thread t = new Thread(() -> {
      while (true) {
        try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        if (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)) continue;
        cache.close();
        Runtime.getRuntime().halt(0);
      }
    }, "fiqh4-parent-watch");
    t.setDaemon(true);
    t.start();
  }
}
