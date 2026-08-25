---
name: fiqh4-arabic-text
description: Arabic normalization and offset-mapping rules in shamela-fiqh-4 — text_original vs text_search, NORMALIZER_VERSION, normalizeArabicWithMap, and why snippets must be cut from the original. Use when touching src/text/, src/search/query.ts, matching, snippets, or highlighting.
---

# fiqh4-arabic-text — التطبيع والاقتطاف

## القاعدة الأولى

| الحقل | المصدر | الاستعمال |
| --- | --- | --- |
| `text_original` | نص الكتاب بعد فك وسوم HTML فقط (`src/text/html.ts`) | **الاقتباس والإحالة حصرًا** |
| `text_search` | مشتق مطبَّع موسوم بإصدار | البحث الداخلي فقط، **لا يُعرض ولا يُقتبس** |

التطبيع **فقدان مقصود ومُوثَّق** للمعلومة (تشكيل، تطويل، صور الألف، `ى→ي`، `ة→ه`). لذلك لا يُقتبس منه أبدًا.

## واجهة `src/text/normalize.ts`

- `NORMALIZER_VERSION` — يدخل في بصمة الفهرس وhash الاستعلام. **أي تغيير في سلوك التطبيع
  يوجب رفع هذا الإصدار**، وإلا صارت المؤشرات والفهارس القديمة صالحة ظاهريًا وخاطئة فعليًا.
- `normalizeArabic(input)` — التطبيع العادي.
- `normalizeArabicWithMap(input): NormalisedWithMap` — يطبّع **مع خريطة إزاحات** تربط كل حرف في
  الناتج بموضعه في الأصل.
- `tokenize` / `tokenizeRaw` / `foldToken`.

## نمط الاقتطاف الإلزامي

ابحث في الفضاء المطبَّع، ثم **اقتطع المقتطف من النص الأصلي** عبر خريطة الإزاحات:

```
normalizeArabicWithMap(original) → طابق في النص المطبَّع → حوّل حدود المطابقة إلى إزاحات أصلية → اقتطع من original
```

لا تعرض المطبَّع للمستخدم بحجة أنه «أقرب للمطابقة» — ليس ما يقوله الكتاب.

## أنماط المطابقة

`phrase` / `all_terms` / `any_terms` (`MATCH_MODES` في `src/search/query.ts`).
hash الاستعلام = نمط المطابقة + الكلمات المطبَّعة + إصدار التطبيع؛ فتغيير أيٍّ منها يُبطل المؤشر بـ `CURSOR_STALE`.

## قبل الإنهاء

`tests/unit/normalize.test.ts` و`html.test.ts` و`query.test.ts` أول ما يكشف الانحراف.
وهناك مرآة للتطبيع في `scripts/lib/normalize-mirror.mjs` تستعملها أدوات البناء — **حدِّثها معًا**
وإلا اختلف ما يُفهرَس عما يُبحَث فيه.
