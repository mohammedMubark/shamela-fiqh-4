---
name: fiqh4-dev
description: Core conventions and non-negotiable invariants of the shamela-fiqh-4 MCP server (layers, read-only Shamela access, schema probing, classification, pagination, truncation). Load before any non-trivial change to src/, tests/, or scripts/.
---

# fiqh4-dev — العمل داخل هذا المستودع

خادم MCP واحد على stdio يبحث في كتب فقه المذاهب الأربعة داخل تثبيت المكتبة الشاملة 4 محليًا.
Node ≥ 22.5 (`node:sqlite` المدمج)، TypeScript ESM، + مساعد Java صغير لقراءة فهارس Lucene.

## الطبقات (لا تتجاوزها)

```
src/index.ts  →  src/tools/ (9 أدوات، Zod)  →  src/pipeline/  →  src/search/ + src/shamela/
```

- `src/tools/*` تُعرِّف المخطط وتبني الاستجابة فقط — لا منطق بحث فيها.
- `src/pipeline/*` الدفعات والمؤشرات والتصدير التدفقي.
- `src/search/engine.ts` واجهة المحرك؛ `shamelaEngine.ts` تنفيذها عبر `luceneBridge.ts`.
- `src/shamela/*` هي **الطريق الوحيد** إلى ملفات المستخدم.

## الثوابت التي لا تُكسر

1. **قراءة فقط.** كل فتح SQLite يمر عبر `src/shamela/sqlite.ts` بـ `DatabaseSync(path, { readOnly: true })`.
   لا تفتح قاعدة شاملة في أي ملف آخر. كل كتابة (فهرس/تصدير) تمر بـ `resolveSafeOutputDir` الذي يرفض
   أي مسار داخل المكتبة (يقارن بـ realpath، فيكشف الروابط الرمزية).
2. **لا أسماء جداول ولا أعمدة ولا أرقام فئات مثبَّتة في `src/`.** الاكتشاف في `src/shamela/schemaProbe.ts`
   عبر قوائم أسماء بديلة. مكتبة غير معروفة ⇒ تشخيص في `fiqh4_health`، لا انهيار.
3. **نصّان:** `text_original` (فك HTML فقط) للاقتباس والإحالة حصرًا؛ `text_search` (مطبَّع، موسوم بإصدار)
   للبحث الداخلي فقط ولا يُعرض. انظر مهارة `fiqh4-arabic-text`.
4. **التصنيف يُعلن ولا يُخفي:** `override` (verified) → `category_map` باسم الفئة لا رقمها → `unclassified`.
   العنوان واسم المؤلف **لا يصنِّفان** — يُنتجان `ambiguity_reasons` ويرفعان الحالة إلى `needs_review`.
   التعارض بين قاعدتين متكافئتين يُترك `unclassified`.
5. **الترحيل keyset لا offset.** الترتيب `(score DESC, doc ASC)`؛ المسح الشامل يرتّب بـ `doc` وحده.
   المؤشر يحمل بصمة الفهرس + hash الاستعلام؛ عدم التطابق ⇒ `CURSOR_STALE`، **لا تصفير صامت للصفحة الأولى**.
6. **لا اقتطاع صامت.** كل استجابة بحث تحمل `total_hits` (دقيق دائمًا) و`returned` و`has_more`
   و`next_cursor` و`truncated` و`truncation_reason`.
7. **لا فتوى ولا ترجيح ولا إثبات إجماع.** قيد بنيوي: مخرجات `compare_issue` لا تحوي حقل حكم،
   ويوجد اختبار يتحقق من ذلك — لا تضف حقلًا يمكن أن يُكتب فيه ترجيح.
8. **لا شبكة.** لا تستورد `node:http/https/net/dgram/tls` ولا `fetch` في `src/`؛ `npm run check:network` يمنع ذلك.
9. **لا بيانات شاملة في المستودع أو الحزمة** (قواعد، نصوص، jars، JRE) — `npm run check:data`.

## متغيرات البيئة

`FIQH4_SHAMELA_DIR` `FIQH4_JAVA_PATH` `FIQH4_OUTPUT_DIR` `FIQH4_OVERRIDES_FILE`
`FIQH4_MAX_RESULTS_PER_RESPONSE` `FIQH4_MAX_RESPONSE_BYTES` `FIQH4_CONCURRENCY` `FIQH4_LOG_LEVEL`
(الشرح في `.env.example`). لا تقرأ `process.env` مباشرة خارج `src/context.ts` إن أمكن.

## الدورة القياسية قبل أي إنهاء

```bash
npm run verify:all
```
= typecheck → build:java → fixtures → test → build:server → smoke → checks.
الاختبارات تعمل على **مجموعة اصطناعية** يولّدها `scripts/make-fixtures.mjs` (وتشمل فهرس Lucene حقيقيًا،
لذا `build:java` قبلها). لا تعتمد أبدًا على مكتبة الشاملة في الاختبارات أو CI.

للتحقق على مكتبة حقيقية: `npm run fiqh4:verify` ثم `npm run fiqh4:diagnose`.

## الأسلوب

التعليقات في هذا المستودع تشرح **لماذا** لا ماذا، وكثير منها مطوّل ومقصود — حافظ على هذا الأسلوب.
الوثائق ثنائية اللغة والواجهة عربية: أي حقل رسالة جديد يحتاج `message_ar` و`message_en`.
