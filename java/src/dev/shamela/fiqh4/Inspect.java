package dev.shamela.fiqh4;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.FieldInfo;
import org.apache.lucene.index.IndexOptions;
import org.apache.lucene.index.IndexableField;
import org.apache.lucene.index.LeafReaderContext;
import org.apache.lucene.index.SegmentReader;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.store.Directory;
import org.apache.lucene.store.FSDirectory;

/**
 * Describe an existing Lucene index: documents, codec, and field layout.
 *
 * A diagnostic, kept because a library that differs from the one this was built
 * against is exactly the case where guessing is worst. Field VALUES are never
 * returned, only their lengths — the caller needs to know which field holds the
 * page body, not what any page says.
 */
public final class Inspect {

    private Inspect() {}

    public static Map<String, Object> describe(String indexDir, int sample) {
        Map<String, Object> result = new LinkedHashMap<>();
        Path dir = Paths.get(indexDir).toAbsolutePath().normalize();
        result.put("index_dir", dir.toString());
        result.put("reader_lucene_version", org.apache.lucene.util.Version.LATEST.toString());

        if (!Files.isDirectory(dir)) {
            result.put("error", "not a directory");
            return result;
        }

        try (Directory directory = FSDirectory.open(dir);
             DirectoryReader reader = DirectoryReader.open(directory)) {

            result.put("num_docs", reader.numDocs());
            result.put("max_doc", reader.maxDoc());
            result.put("deleted_docs", reader.numDeletedDocs());
            result.put("segments", reader.leaves().size());
            result.put("generation", String.valueOf(reader.getVersion()));

            List<Object> segs = new ArrayList<>();
            for (LeafReaderContext ctx : reader.leaves()) {
                if (!(ctx.reader() instanceof SegmentReader sr)) continue;
                segs.add(Json.obj(
                        "name", sr.getSegmentInfo().info.name,
                        "codec", sr.getSegmentInfo().info.getCodec().getName(),
                        "docs", sr.getSegmentInfo().info.maxDoc(),
                        "created_by", String.valueOf(sr.getSegmentInfo().info.getVersion())));
                if (segs.size() >= 5) break;
            }
            result.put("segment_sample", segs);

            Map<String, Map<String, Object>> fields = new LinkedHashMap<>();
            for (LeafReaderContext ctx : reader.leaves()) {
                for (FieldInfo fi : ctx.reader().getFieldInfos()) {
                    Map<String, Object> f = fields.computeIfAbsent(fi.name, k -> new HashMap<>());
                    f.put("name", fi.name);
                    f.put("indexed", fi.getIndexOptions() != IndexOptions.NONE);
                    f.put("index_options", fi.getIndexOptions().toString());
                    f.put("doc_values", fi.getDocValuesType().toString());
                    f.putIfAbsent("stored", Boolean.FALSE);
                }
            }

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
                List<Object> present = new ArrayList<>();
                for (IndexableField f : d.getFields()) {
                    Map<String, Object> fi = fields.get(f.name());
                    if (fi != null) fi.put("stored", Boolean.TRUE);
                    String v = f.stringValue();
                    Map<String, Object> entry = new LinkedHashMap<>();
                    entry.put("field", f.name());
                    if (v != null) {
                        entry.put("type", "string");
                        entry.put("length", v.length());
                    } else if (f.numericValue() != null) {
                        entry.put("type", "numeric");
                        entry.put("value", f.numericValue().longValue());
                    } else {
                        entry.put("type", "other");
                    }
                    present.add(entry);
                }
                samples.add(Json.obj("doc", i, "stored_fields", present));
            }

            result.put("fields", new ArrayList<>(fields.values()));
            result.put("sample_docs", samples);
        } catch (IOException | RuntimeException e) {
            result.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        return result;
    }
}
