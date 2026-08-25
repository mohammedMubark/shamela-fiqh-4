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

/**
 * Opens the Lucene indexes under {@code database/store} and keeps the readers
 * for the lifetime of the process.
 *
 * Opening an index costs tens of milliseconds and the page index holds millions
 * of documents, so readers are created on first use and reused. Every index is
 * opened read-only through a {@link DirectoryReader}, which never writes and
 * never takes the write lock — a running Shamela is undisturbed.
 */
public final class IndexCache implements AutoCloseable {

    public static final String PAGE = "page";
    public static final String TITLE = "title";

    private final Path storeRoot;
    private final Map<String, Entry> entries = new HashMap<>();

    private record Entry(Directory directory, DirectoryReader reader,
                         IndexSearcher searcher, StoredFields stored) {}

    public IndexCache(Path storeRoot) {
        this.storeRoot = storeRoot;
    }

    public synchronized IndexSearcher searcher(String name) throws IOException {
        return entry(name).searcher;
    }

    public synchronized StoredFields storedFields(String name) throws IOException {
        return entry(name).stored;
    }

    public synchronized DirectoryReader reader(String name) throws IOException {
        return entry(name).reader;
    }

    public boolean exists(String name) {
        return Files.isDirectory(storeRoot.resolve(name));
    }

    private Entry entry(String name) throws IOException {
        Entry e = entries.get(name);
        if (e != null) return e;
        Path indexPath = storeRoot.resolve(name);
        if (!Files.isDirectory(indexPath)) {
            throw new IOException("index directory not found: " + indexPath);
        }
        Directory dir = FSDirectory.open(indexPath);
        DirectoryReader reader = DirectoryReader.open(dir);
        e = new Entry(dir, reader, new IndexSearcher(reader), reader.storedFields());
        entries.put(name, e);
        return e;
    }

    @Override
    public synchronized void close() {
        for (Entry e : entries.values()) {
            try {
                e.reader.close();
            } catch (IOException ignore) {
                // A read-only reader cannot lose data on close.
            }
            try {
                e.directory.close();
            } catch (IOException ignore) {
                // Same.
            }
        }
        entries.clear();
    }
}
