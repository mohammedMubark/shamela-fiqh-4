package dev.shamela.fiqh4.testing;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import org.apache.lucene.analysis.core.WhitespaceAnalyzer;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.StringField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.store.Directory;
import org.apache.lucene.store.FSDirectory;

/**
 * Builds a Lucene index shaped like Shamela's, for test fixtures only.
 *
 * This is deliberately NOT part of the shipped helper. That helper opens
 * Shamela's indexes read-only and must never be able to write to a user's
 * library; keeping the only writing code in a separate, test-only tool makes
 * that a structural guarantee rather than a promise.
 *
 * Reads JSON lines of {"id", "body", "tokens", "foot"} from stdin and writes
 * them with the same field names and key format Shamela uses, so tests exercise
 * the real access path.
 *
 * `body` is written twice under one name, which is what models Shamela: a
 * stored copy holding the ORIGINAL text so it can be quoted with its diacritics
 * intact, and an indexed copy holding the folded tokens so a folded query can
 * match. Shamela achieves the same split with its analyzer; doing it explicitly
 * here means this tool needs no analyzer of its own and cannot drift from the
 * folding the extension applies to queries.
 */
public final class FixtureIndexer {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: FixtureIndexer <indexDir>");
            System.exit(2);
        }
        Path dir = Paths.get(args[0]).toAbsolutePath().normalize();
        Files.createDirectories(dir);

        IndexWriterConfig cfg = new IndexWriterConfig(new WhitespaceAnalyzer());
        cfg.setOpenMode(IndexWriterConfig.OpenMode.CREATE);

        int written = 0;
        try (Directory directory = FSDirectory.open(dir);
             IndexWriter writer = new IndexWriter(directory, cfg);
             BufferedReader in = new BufferedReader(
                     new InputStreamReader(System.in, StandardCharsets.UTF_8))) {

            String line;
            while ((line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                Doc d = Doc.parse(line);
                if (d.id == null) continue;

                Document doc = new Document();
                // Shamela keys every page and heading "<book_id>-<row_id>".
                doc.add(new StringField("id", d.id, Field.Store.YES));
                // Shamela carries the book id as its own field, which is what
                // makes scoping a filter rather than a walk over every hit.
                int dash = d.id.indexOf('-');
                if (dash > 0) {
                    doc.add(new StringField("book_key", d.id.substring(0, dash), Field.Store.YES));
                }
                // Stored: the original, for quoting. Indexed: the folded
                // tokens, for matching. Same field name, as Shamela has it.
                doc.add(new StoredField("body", d.body == null ? "" : d.body));
                doc.add(new TextField("body", d.tokens == null ? "" : d.tokens, Field.Store.NO));
                if (d.foot != null && !d.foot.isEmpty()) {
                    doc.add(new StoredField("foot", d.foot));
                }
                writer.addDocument(doc);
                written++;
            }
            writer.commit();
        }
        System.out.println(written);
    }

    /** Minimal reader for the three fields this tool consumes. */
    private static final class Doc {
        String id;
        String body;
        String tokens;
        String foot;

        static Doc parse(String json) {
            Doc d = new Doc();
            d.id = str(json, "id");
            d.body = str(json, "body");
            d.tokens = str(json, "tokens");
            d.foot = str(json, "foot");
            return d;
        }

        /** Extract one string field, honouring the escapes the generator emits. */
        private static String str(String json, String key) {
            String needle = "\"" + key + "\":";
            int at = json.indexOf(needle);
            if (at < 0) return null;
            int i = at + needle.length();
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i >= json.length() || json.charAt(i) != '"') return null;
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < json.length()) {
                char c = json.charAt(i++);
                if (c == '"') break;
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char esc = json.charAt(i++);
                switch (esc) {
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        sb.append((char) Integer.parseInt(json.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> sb.append(esc);
                }
            }
            return sb.toString();
        }
    }
}
