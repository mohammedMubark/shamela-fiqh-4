# قياسات الأداء — shamela-fiqh-4

## بوابات القبول

على جهاز القبول Windows مع `D:\shamela`:

| الفحص | الحد |
| --- | ---: |
| `fiqh4_health` بارد | ≤ 20 ثانية |
| بحث دافئ يعيد 50 نتيجة | ≤ 5 ثوانٍ |
| اكتشاف مسألة عبر نطاق المذاهب الأربعة | ≤ 30 ثانية |
| أي عملية طويلة | مهلة قصوى 120 ثانية ورسالة عربية واضحة |

## ما يقيسه المشروع

```bash
npm run build
npm run fixtures
npm run smoke
npm run fiqh4:verify -- --out verify.json
npm run fiqh4:bench
```

لا يوجد بناء فهرس. الأرقام تخص القراءة المباشرة من فهارس الشاملة:

- `database/store/page`
- `database/store/title`
- `app/lucene/2`

## مؤشرات يجب توثيقها

| القياس | المصدر |
| --- | --- |
| عدد وثائق الصفحات | `fiqh4_health.index.page_docs` |
| عدد وثائق العناوين | `fiqh4_health.index.title_docs` |
| بصمة فهرس الصفحات | `fiqh4_health.index.page_commit` |
| Java المستخدمة | `fiqh4_health.engines.lucene.java_path` |
| مسار Lucene | `fiqh4_health.engines.lucene.lucene_dir` |
| الكتب التي لها صفحات Lucene | `fiqh4_health.index.books_with_lucene_pages` |

## ملاحظات تفسير الأرقام

- `phrase` أدق وأسرع غالبًا.
- `all_terms` مناسب للاستكشاف.
- `any_terms` قد يطابق عددًا ضخمًا من الصفحات.
- التصفح العميق المرتب بالصلة مكلف بطبيعته؛ للاستقصاء الكامل استخدم `fiqh4_export_results` لأنه يمسح بترتيب المستند ويدعم الاستئناف.
- حجم النتائج لا يجب أن يتحول إلى نمو ذاكرة خطي؛ إن ظهر ذلك فهو خلل.

## أرقام التركيب الحقيقي

لا تُسجَّل أرقام هنا إلا إذا نتجت من الأوامر أعلاه على جهاز معلوم. عند تدوين نتيجة، اذكر:

- التاريخ.
- نسخة Node.
- Java المستخدمة.
- commit فهرس الصفحات.
- عدد الكتب والوثائق.
- الاستعلام ونمط المطابقة.
- p50/p95 أو الزمن الكلي.

