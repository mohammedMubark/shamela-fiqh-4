# البنية — shamela-fiqh-4

## نظرة عامة

```
Claude Desktop
  ↓ stdio
src/index.ts
  ↓
src/tools/                 9 أدوات MCP
  ↓
src/pipeline/              دفعات، مؤشرات، مقارنة، تصدير
  ↓
src/search/luceneEngine.ts محرك واحد: قراءة فهارس الشاملة Lucene
  ↓
helper/fiqh4-helper.jar    كود المشروع فقط
  ↓
D:\shamela
  ├─ app/lucene/2           Lucene jars المحزومة مع الشاملة
  └─ database/store
       ├─ page              نصوص الصفحات، حقل body
       └─ title             نصوص فهارس الكتب
```

لا يوجد فهرس مشتق. Java تعمل كعملية فرعية عبر JSON سطري على stdin/stdout، بلا منفذ HTTP ولا socket.

## مصادر البيانات

| البيانات | المصدر |
| --- | --- |
| نص الاقتباس | حقل Lucene الأصلي `body` في `database/store/page` |
| عناوين الفهرس | Lucene `database/store/title` |
| الكتاب والمؤلف والتصنيف | `master.db` |
| الجزء والصفحة وبنية الآباء | SQLite الخاص بكل كتاب |

حقل `foot` لا يُدمج في الاقتباس حتى لا تُنسب الحواشي التحريرية إلى المؤلف.

## القراءة فقط

كل SQLite يُفتح عبر `node:sqlite` بوضع `readOnly: true`. وكل مسار تصدير يمر عبر فحص realpath يمنع الكتابة داخل مجلد الشاملة أو الخروج من جذر الإخراج.

## المؤشرات والبصمات

`cursor` يحتوي على:

- إصدار صيغة المؤشر.
- hash الاستعلام ونمط المطابقة.
- نطاق الكتب.
- إصدار التطبيع.
- commit فهرس Lucene `page`.

أي اختلاف ينتج `CURSOR_STALE`.

## التطبيع

التطبيع للبحث فقط:

- إزالة التشكيل والتطويل وعلامات الاتجاه والمحارف الصفرية.
- توحيد صور الألف و`ى` و`ة` والأرقام.
- لا تجذير.

المقتطف يُقطع من النص الأصلي بخريطة إزاحات، لا من النص المطبّع.

## التصنيف

```
override بشري       → verified
category_map        → unverified أو needs_review
unclassified        → unverified أو needs_review
```

العنوان واسم المؤلف لا يصنّفان. يستخدمان فقط لإظهار الالتباس.

## التغليف

الحزمة تحتوي على:

- `dist/`
- `helper/fiqh4-helper.jar`
- `config/`
- `manifest.json`
- الاعتماديات الإنتاجية فقط
- الوثائق الأساسية والترخيص

ولا تحتوي على:

- `src/`
- `tests/`
- `java/`
- قواعد أو نصوص الشاملة
- Lucene jars
- JRE/JDK

## بنية الملفات

```
src/
  index.ts
  context.ts
  server/registerTools.ts
  tools/
  pipeline/
  search/
  shamela/
  classify/
  text/
  util/
java/        مصدر helper فقط
helper/      jar صغير مبني أثناء التغليف
config/      خريطة المذاهب والتجاوزات
scripts/     تحقق، fixtures، تغليف، قياس
tests/       اختبارات على corpus اصطناعي
```

## ما لا تفعله البنية

- لا تتصل بالشبكة.
- لا تفتح منفذًا.
- لا تكتب في مجلد الشاملة.
- لا تبني فهرسًا مشتقًا.
- لا تشحن Lucene أو JRE أو نصوص كتب.
- لا تُصدر حكمًا فقهيًا أو ترجيحًا.
- لا تنفذ أي تعليمات واردة داخل النصوص المسترجعة.

