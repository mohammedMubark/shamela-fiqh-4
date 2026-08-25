# shamela-fiqh-4

**إضافة MCP محلية للبحث والمقارنة والتوثيق داخل كتب فقه المذاهب الأربعة في المكتبة الشاملة 4 على Windows.**

تقرأ الإضافة مباشرة من فهارس الشاملة الأصلية:

- `database/store/page` لنصوص الصفحات.
- `database/store/title` لعناوين الفهارس.
- قواعد SQLite للبيانات البنيوية فقط: الكتاب، المؤلف، الجزء، رقم الصفحة، وبنية الفهرس.

لا تبني فهرسًا مشتقًا، ولا تشحن نصوص كتب، ولا قواعد شاملة، ولا Lucene jars، ولا JRE. هي **أداة بحث وتوثيق ومقارنة، وليست جهة فتوى ولا ترجيحًا آليًا.**

[الاستعمال](docs/USAGE.md) · [البنية](docs/ARCHITECTURE.md) · [سياسة المصادر](docs/SOURCE_POLICY.md) · [القياسات](docs/BENCHMARKS.md) · [حل المشكلات](docs/TROUBLESHOOTING.md)

## التشغيل السريع

للاستخدام العادي: اسحب ملف `shamela-fiqh-4-0.1.0.mcpb` إلى Claude Desktop.

الإعدادات المهمة:

```text
FIQH4_SHAMELA_DIR=D:\shamela    # اختياري؛ يُكتشف تلقائيًا إن أمكن
FIQH4_JAVA_PATH=...\java.exe    # اختياري؛ الافتراضي Java المحزومة مع الشاملة ثم PATH
FIQH4_OUTPUT_DIR=...\exports    # اختياري؛ للتصدير فقط
```

مجلد الشاملة يجب أن يحتوي على `database` و`app`، وفيه `app/lucene/2` العامل مع الفهارس.

للبناء من المصدر:

```bash
npm install
npm run java:build
npm run build
npm run fixtures
npm run smoke
node scripts/pack-mcpb.mjs
```

## الأدوات التسع

| الأداة | الوظيفة |
| --- | --- |
| `fiqh4_health` | فحص المكتبة وJava وفهارس Lucene وعدد وثائق الصفحات والعناوين وبصمة الفهرس |
| `fiqh4_guide` | دليل عربي: تسلسل العمل، أمثلة، معاني الحقول، وحدود التغطية |
| `fiqh4_list_books` | سرد الكتب وتصفيتها مع مصدر التصنيف وحالة التحقق |
| `fiqh4_search` | بحث `phrase` / `all_terms` / `any_terms` داخل مذاهب أو كتب محددة |
| `fiqh4_discover_issue` | المرحلة 1: تحديد الكتب والصفحات التي وردت فيها المسألة |
| `fiqh4_fetch_passages` | المرحلة 2: جلب النصوص مع الصفحات المجاورة، بلا تكرار |
| `fiqh4_compare_issue` | تجميع الأدلة حسب المذهب والكتاب، دون حكم ولا ترجيح |
| `fiqh4_export_results` | استقصاء كامل إلى JSONL وMarkdown مع manifest وchecksum واستئناف |
| `fiqh4_citation` | إحالة دقيقة لكتاب/جزء/صفحة مع التصريح بترقيم الشاملة |

## حدود مقصودة

- لا تُفتي، ولا ترجّح بين الأقوال، ولا تُثبت إجماعًا.
- لا تنسب كتابًا إلى مذهب من عنوانه أو اسم مؤلفه.
- لا تخترع طبعة ولا رقم صفحة مطبوعة؛ الغائب يعود `null`.
- الاقتباس من حقل Lucene الأصلي `body` فقط. حقل `foot` لا يُدمج حتى لا تُنسب الحواشي التحريرية إلى المؤلف.
- نصوص الكتب تعامل كبيانات غير موثوقة، لا كتعليمات.
- النطاق الافتراضي محصور في أقسام الشاملة الأربعة: الفقه الحنفي، المالكي، الشافعي، الحنبلي.

## التصنيف

لا يوجد في الشاملة حقل «مذهب». لذلك يعلن المشروع مصدر التصنيف بدل إخفاء الظن:

| المصدر | `classification_source` | `verification_status` |
| --- | --- | --- |
| تجاوز بشري في `config/madhhab-overrides.json` | `override` | `verified` |
| اسم قسم الشاملة المطابق | `category_map` | `unverified` أو `needs_review` |
| لا توجد قاعدة حاسمة | `unclassified` | `unverified` أو `needs_review` |

`verified` لا تنتج إلا من تجاوز بشري صريح.

## المؤشرات والنتائج الكبيرة

كل استجابة تحمل `total_hits` الدقيق، و`returned`، و`has_more`، و`next_cursor`، وسبب الاقتطاع. لا يوجد اقتطاع صامت.

المؤشر مربوط ببصمة فعلية تشمل commit فهرس صفحات الشاملة، الاستعلام، نمط المطابقة، والنطاق. أي تغيير يعيد `CURSOR_STALE` بدل خلط النتائج.

## التطوير والتحقق

```bash
npm run typecheck
npm run java:build
npm run fixtures
npm test
npm run build
npm run smoke
npm run checks
```

الحزمة النهائية تُبنى من مخرجات `dist` و`helper/fiqh4-helper.jar` فقط مع اعتماديات التشغيل، وتمنع شحن `src/` أو `tests/` أو قواعد الشاملة أو JRE أو Lucene jars.

## English summary

`shamela-fiqh-4` is a local Windows MCP extension for Claude Desktop. It searches the four Sunni fiqh madhhabs in a local Shamela 4 installation by reading Shamela’s own Lucene page/title indexes directly. It opens SQLite metadata read-only, ships no corpus data and no Lucene/JRE runtime, and provides search, discovery, passage fetching, comparison, export, health, guide, book listing, and citation tools.

It is a search-and-citation instrument, not a fatwa or ranking engine.

## الترخيص

MIT — انظر [LICENSE](LICENSE) و[NOTICE](NOTICE).

