package dev.shamela.fiqh4;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;

import org.apache.lucene.analysis.core.WhitespaceAnalyzer;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.StringField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.store.FSDirectory;

/** Test-only builder for synthetic Shamela-shaped Lucene indexes. */
public final class FixtureIndexer {
  private static final String F_ID = "id";
  private static final String F_BOOK = "book_key";
  private static final String F_BODY = "body";
  private static final String F_PARENT = "parent";

  public static void main(String[] args) throws Exception {
    if (args.length < 3) {
      throw new IllegalArgumentException("usage: FixtureIndexer <root> <pages.jsonl> <titles.jsonl>");
    }
    Path root = Paths.get(args[0]);
    Path pages = Paths.get(args[1]);
    Path titles = Paths.get(args[2]);
    writePages(root.resolve("database").resolve("store").resolve("page"), pages);
    writeTitles(root.resolve("database").resolve("store").resolve("title"), titles);
  }

  private static void writePages(Path dir, Path jsonl) throws Exception {
    Files.createDirectories(dir);
    IndexWriterConfig cfg = new IndexWriterConfig(new WhitespaceAnalyzer());
    cfg.setOpenMode(IndexWriterConfig.OpenMode.CREATE);
    try (IndexWriter writer = new IndexWriter(FSDirectory.open(dir), cfg);
         BufferedReader in = Files.newBufferedReader(jsonl, StandardCharsets.UTF_8)) {
      String line;
      while ((line = in.readLine()) != null) {
        if (line.isBlank()) continue;
        Map<String, Object> row = Json.parseObject(line);
        String book = String.valueOf(row.get("book_id"));
        int page = Json.asInt(row.get("page_id"), 0);
        String body = String.valueOf(row.getOrDefault("body", ""));
        org.apache.lucene.document.Document d = new org.apache.lucene.document.Document();
        d.add(new StringField(F_ID, book + "-" + page, Field.Store.YES));
        d.add(new StringField(F_BOOK, book, Field.Store.YES));
        d.add(new StoredField(F_BODY, body));
        d.add(new TextField(F_BODY, Normalize.normalizeText(body), Field.Store.NO));
        writer.addDocument(d);
      }
      writer.commit();
    }
  }

  private static void writeTitles(Path dir, Path jsonl) throws Exception {
    Files.createDirectories(dir);
    IndexWriterConfig cfg = new IndexWriterConfig(new WhitespaceAnalyzer());
    cfg.setOpenMode(IndexWriterConfig.OpenMode.CREATE);
    try (IndexWriter writer = new IndexWriter(FSDirectory.open(dir), cfg);
         BufferedReader in = Files.newBufferedReader(jsonl, StandardCharsets.UTF_8)) {
      String line;
      while ((line = in.readLine()) != null) {
        if (line.isBlank()) continue;
        Map<String, Object> row = Json.parseObject(line);
        String book = String.valueOf(row.get("book_id"));
        int id = Json.asInt(row.get("title_id"), 0);
        String body = String.valueOf(row.getOrDefault("text", ""));
        org.apache.lucene.document.Document d = new org.apache.lucene.document.Document();
        d.add(new StringField(F_ID, book + "-" + id, Field.Store.YES));
        d.add(new StringField(F_BOOK, book, Field.Store.YES));
        d.add(new StoredField(F_BODY, body));
        d.add(new TextField(F_BODY, Normalize.normalizeText(body), Field.Store.NO));
        Object parent = row.get("parent_id");
        if (parent != null) d.add(new StoredField(F_PARENT, String.valueOf(parent)));
        writer.addDocument(d);
      }
      writer.commit();
    }
  }
}
