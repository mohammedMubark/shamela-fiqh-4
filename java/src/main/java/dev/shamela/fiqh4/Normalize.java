package dev.shamela.fiqh4;

import java.util.ArrayList;
import java.util.List;

/** Query folding compatible with Shamela's page/title Lucene indexes. */
final class Normalize {
  private Normalize() {}

  private static final String DIACRITICS = "ًٌٍَُِّْٰـ";
  private static final String QURANIC_MARKS =
      "ۖۗۘۙۚۛۜ۝۞ۣ۟۠ۡۢۤۥۦۧۨ۩ࣰࣱࣲ۪ۭٕٖٜٟ۫۬ࣳٓٔٗ٘ٙٚٛٝٞ";
  private static final String INVISIBLES = "​‌‍‎‏⁦⁧⁨⁩؜﻿";

  static List<String> normalizeTerms(List<Object> raw) {
    List<String> out = new ArrayList<>();
    if (raw == null) return out;
    for (Object o : raw) {
      if (o == null) continue;
      String s = normalizeToken(String.valueOf(o));
      if (!s.isEmpty()) out.add(s);
    }
    return out;
  }

  static String normalizeToken(String token) {
    if (token == null || token.isEmpty()) return "";
    String stripped = stripPunctuation(token);
    StringBuilder sb = new StringBuilder(stripped.length());
    for (int i = 0; i < stripped.length(); i++) {
      char c = stripped.charAt(i);
      if (isDropped(c)) continue;
      sb.append(fold(c));
    }
    String result = sb.toString().trim();
    return "ابن".equals(result) ? "بن" : result;
  }

  static String normalizeText(String text) {
    if (text == null || text.isEmpty()) return "";
    StringBuilder sb = new StringBuilder(text.length());
    boolean pendingSpace = false;
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (isDropped(c)) continue;
      char f = fold(c);
      if (Character.isLetterOrDigit(f)) {
        if (pendingSpace && sb.length() > 0) sb.append(' ');
        sb.append(f);
        pendingSpace = false;
      } else {
        pendingSpace = true;
      }
    }
    return sb.toString().trim();
  }

  private static boolean isDropped(char c) {
    return DIACRITICS.indexOf(c) >= 0 || QURANIC_MARKS.indexOf(c) >= 0 || INVISIBLES.indexOf(c) >= 0;
  }

  private static char fold(char c) {
    return switch (c) {
      case 'ٱ', 'آ', 'أ', 'إ' -> 'ا';
      case 'ى', 'ی' -> 'ي';
      case 'ؤ' -> 'و';
      case 'ة' -> 'ه';
      case 'گ', 'ک' -> 'ك';
      case 'پ' -> 'ب';
      case 'چ' -> 'ج';
      default -> c;
    };
  }

  private static String stripPunctuation(String token) {
    int start = 0;
    int end = token.length();
    while (start < end && isPunct(token.charAt(start))) start++;
    while (end > start && isPunct(token.charAt(end - 1))) end--;
    return token.substring(start, end);
  }

  private static boolean isPunct(char c) {
    if (Character.isLetter(c)) return false;
    if (c >= '٠' && c <= '٩') return true;
    if (c >= '۰' && c <= '۹') return true;
    if (Character.isDigit(c)) return true;
    return !Character.isLetterOrDigit(c);
  }
}
