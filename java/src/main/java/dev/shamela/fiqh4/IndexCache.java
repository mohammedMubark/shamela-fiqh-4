package dev.shamela.fiqh4;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.store.Directory;
import org.apache.lucene.store.FSDirectory;

/** Read-only cache for Shamela's Lucene indexes under database/store. */
final class IndexCache implements AutoCloseable {
  static final String PAGE = "page";
  static final String TITLE = "title";

  private final Path storeRoot;
  private final Map<String, Entry> entries = new HashMap<>();

  private record Entry(Directory dir, DirectoryReader reader, IndexSearcher searcher, StoredFields stored) {}

  IndexCache(Path installRoot) {
    this.storeRoot = installRoot.resolve("database").resolve("store");
  }

  boolean exists(String name) {
    return Files.isDirectory(storeRoot.resolve(name));
  }

  synchronized DirectoryReader reader(String name) throws IOException {
    return entry(name).reader;
  }

  synchronized IndexSearcher searcher(String name) throws IOException {
    return entry(name).searcher;
  }

  synchronized StoredFields stored(String name) throws IOException {
    return entry(name).stored;
  }

  synchronized int numDocs(String name) throws IOException {
    return entry(name).reader.numDocs();
  }

  synchronized String commitId(String name) throws IOException {
    DirectoryReader r = entry(name).reader;
    return r.getIndexCommit().getSegmentsFileName() + ":" + r.getIndexCommit().getGeneration() + ":" + r.getVersion();
  }

  private Entry entry(String name) throws IOException {
    Entry cached = entries.get(name);
    if (cached != null) return cached;
    Path p = storeRoot.resolve(name);
    if (!Files.isDirectory(p)) throw new IOException("index directory not found: " + p);
    Directory dir = FSDirectory.open(p);
    DirectoryReader reader = DirectoryReader.open(dir);
    Entry entry = new Entry(dir, reader, new IndexSearcher(reader), reader.storedFields());
    entries.put(name, entry);
    return entry;
  }

  @Override
  public synchronized void close() {
    for (Entry e : entries.values()) {
      try { e.reader.close(); } catch (IOException ignored) { }
      try { e.dir.close(); } catch (IOException ignored) { }
    }
    entries.clear();
  }
}
