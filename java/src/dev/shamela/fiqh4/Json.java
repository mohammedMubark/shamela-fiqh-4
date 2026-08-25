package dev.shamela.fiqh4;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader/writer for the bridge protocol.
 *
 * Deliberately hand-rolled rather than pulling in Jackson or Gson: the bridge
 * exchanges a handful of flat shapes with one trusted local process, and every
 * extra dependency is more weight in a jar the user has to build themselves.
 */
final class Json {

  private Json() {}

  /** Build a small ordered map from alternating key/value pairs. */
  static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) {
      m.put(String.valueOf(kv[i]), kv[i + 1]);
    }
    return m;
  }

  // ── writing ───────────────────────────────────────────────────────────────

  static String ok(long id, Object result) {
    StringBuilder sb = new StringBuilder(256);
    sb.append("{\"id\":").append(id).append(",\"ok\":true,\"result\":");
    write(sb, result);
    return sb.append('}').toString();
  }

  static String error(long id, String message) {
    StringBuilder sb = new StringBuilder(128);
    sb.append("{\"id\":").append(id).append(",\"ok\":false,\"error\":");
    writeString(sb, message);
    return sb.append('}').toString();
  }

  @SuppressWarnings("unchecked")
  static void write(StringBuilder sb, Object v) {
    if (v == null) { sb.append("null"); return; }
    if (v instanceof String) { writeString(sb, (String) v); return; }
    if (v instanceof Boolean || v instanceof Integer || v instanceof Long) { sb.append(v); return; }
    if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      // JSON has no NaN or Infinity; emit null rather than invalid output.
      sb.append(Double.isFinite(d) ? String.valueOf(d) : "null");
      return;
    }
    if (v instanceof Map) {
      sb.append('{');
      boolean first = true;
      for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
        if (!first) sb.append(',');
        first = false;
        writeString(sb, e.getKey());
        sb.append(':');
        write(sb, e.getValue());
      }
      sb.append('}');
      return;
    }
    if (v instanceof Iterable) {
      sb.append('[');
      boolean first = true;
      for (Object o : (Iterable<Object>) v) {
        if (!first) sb.append(',');
        first = false;
        write(sb, o);
      }
      sb.append(']');
      return;
    }
    writeString(sb, String.valueOf(v));
  }

  static void writeString(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':  sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n");  break;
        case '\r': sb.append("\\r");  break;
        case '\t': sb.append("\\t");  break;
        case '\b': sb.append("\\b");  break;
        case '\f': sb.append("\\f");  break;
        default:
          // Control characters must be escaped; Arabic and everything else
          // above U+001F is emitted as-is (the stream is UTF-8).
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    sb.append('"');
  }

  // ── reading ───────────────────────────────────────────────────────────────

  static Map<String, Object> parseObject(String s) {
    Parser p = new Parser(s);
    p.skipWhitespace();
    Object v = p.value();
    return asObject(v);
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> asObject(Object v) {
    if (v instanceof Map) return (Map<String, Object>) v;
    throw new IllegalArgumentException("expected a JSON object");
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> asObjectOrNull(Object v) {
    return v instanceof Map ? (Map<String, Object>) v : null;
  }

  @SuppressWarnings("unchecked")
  static List<Object> asList(Object v) {
    return v instanceof List ? (List<Object>) v : List.of();
  }

  static int asInt(Object v, int fallback) {
    if (v instanceof Number) return ((Number) v).intValue();
    if (v instanceof String) {
      try { return Integer.parseInt(((String) v).trim()); } catch (NumberFormatException e) { return fallback; }
    }
    return fallback;
  }

  static double asDouble(Object v, double fallback) {
    if (v instanceof Number) return ((Number) v).doubleValue();
    if (v instanceof String) {
      try { return Double.parseDouble(((String) v).trim()); } catch (NumberFormatException e) { return fallback; }
    }
    return fallback;
  }

  private static final class Parser {
    private final String src;
    private int pos;

    Parser(String src) { this.src = src; }

    void skipWhitespace() {
      while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
    }

    Object value() {
      skipWhitespace();
      if (pos >= src.length()) throw new IllegalArgumentException("unexpected end of JSON");
      char c = src.charAt(pos);
      switch (c) {
        case '{': return object();
        case '[': return array();
        case '"': return string();
        case 't': expect("true");  return Boolean.TRUE;
        case 'f': expect("false"); return Boolean.FALSE;
        case 'n': expect("null");  return null;
        default:  return number();
      }
    }

    private void expect(String word) {
      if (!src.startsWith(word, pos)) throw new IllegalArgumentException("invalid JSON literal at " + pos);
      pos += word.length();
    }

    private Map<String, Object> object() {
      Map<String, Object> map = new LinkedHashMap<>();
      pos++; // '{'
      skipWhitespace();
      if (pos < src.length() && src.charAt(pos) == '}') { pos++; return map; }
      while (true) {
        skipWhitespace();
        String key = string();
        skipWhitespace();
        if (src.charAt(pos) != ':') throw new IllegalArgumentException("expected ':' at " + pos);
        pos++;
        map.put(key, value());
        skipWhitespace();
        char c = src.charAt(pos);
        if (c == ',') { pos++; continue; }
        if (c == '}') { pos++; return map; }
        throw new IllegalArgumentException("expected ',' or '}' at " + pos);
      }
    }

    private List<Object> array() {
      List<Object> list = new ArrayList<>();
      pos++; // '['
      skipWhitespace();
      if (pos < src.length() && src.charAt(pos) == ']') { pos++; return list; }
      while (true) {
        list.add(value());
        skipWhitespace();
        char c = src.charAt(pos);
        if (c == ',') { pos++; continue; }
        if (c == ']') { pos++; return list; }
        throw new IllegalArgumentException("expected ',' or ']' at " + pos);
      }
    }

    private String string() {
      if (src.charAt(pos) != '"') throw new IllegalArgumentException("expected a string at " + pos);
      pos++;
      StringBuilder sb = new StringBuilder();
      while (true) {
        char c = src.charAt(pos++);
        if (c == '"') return sb.toString();
        if (c != '\\') { sb.append(c); continue; }
        char esc = src.charAt(pos++);
        switch (esc) {
          case '"':  sb.append('"');  break;
          case '\\': sb.append('\\'); break;
          case '/':  sb.append('/');  break;
          case 'n':  sb.append('\n'); break;
          case 'r':  sb.append('\r'); break;
          case 't':  sb.append('\t'); break;
          case 'b':  sb.append('\b'); break;
          case 'f':  sb.append('\f'); break;
          case 'u':
            sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
            pos += 4;
            break;
          default: throw new IllegalArgumentException("invalid escape \\" + esc);
        }
      }
    }

    private Object number() {
      int start = pos;
      while (pos < src.length() && "+-0123456789.eE".indexOf(src.charAt(pos)) >= 0) pos++;
      String text = src.substring(start, pos);
      if (text.isEmpty()) throw new IllegalArgumentException("invalid JSON at " + start);
      if (text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0) {
        try { return Long.valueOf(text); } catch (NumberFormatException ignored) { /* fall through */ }
      }
      return Double.valueOf(text);
    }
  }
}
