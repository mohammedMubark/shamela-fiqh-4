---
name: fiqh4-lucene-java
description: The Java Lucene helper of shamela-fiqh-4 — why it exists, the NDJSON child-process protocol, JDK 21 build rules, and how failures must surface. Use when touching java/, scripts/build-java.mjs, src/search/luceneBridge.ts, or shamelaEngine.ts.
---

# fiqh4-lucene-java — مساعد Lucene

## لماذا يوجد

الشاملة 4 تحفظ **نص كل صفحة داخل فهارس Lucene** تحت `database/store`. فالمساعد ليس تسريعًا
اختياريًا — هو **الطريق الوحيد** إلى نص الكتب. قواعد SQLite تعطي البيانات الوصفية والترقيم فقط.

## ما يُشحن وما لا يُشحن

- يُشحن: بضعة كيلوبايت من الـ class files المترجمة من `java/src` (تحت `java/classes`).
- **لا يُشحن**: JRE ولا jars Lucene. التشغيل يستعمل **Java الشاملة نفسها** و**jars الشاملة**
  (`app/lucene/2`) على الـ classpath. هذا ما يُبقي `check:data` مارًّا ويُغني المستخدم عن أي بناء.
- JDK 21+ مطلوب **وقت البناء فقط**: Lucene 10.4 التي تشحنها الشاملة مترجمة لجافا 21، فأقدم منه
  لا يترجم مقابلها. `scripts/build-java.mjs` يفحص إصدار `javac` ويشرح السبب بدل الفشل الغامض.

## البروتوكول

JSON مفصول بأسطر (NDJSON) عبر stdin/stdout لعملية ابن — **لا socket ولا منفذ**.

```
request  { id, cmd, ... }
response { id, ok, result? , error? }
cmd ∈ health | search | counts | pages | getPages | getTitles | inspect | close
```

الجانب TS: `LuceneBridge` في `src/search/luceneBridge.ts` (طابور `pending` بمهلة، افتراضها 180s).
الجانب Java: `Main.dispatch` في `java/src/dev/shamela/fiqh4/Main.java` + `Commands` + `IndexCache` + `Json`.
**أي أمر جديد يُضاف في الطرفين معًا** وإلا فـ `unknown command`.

## الأخطاء تظهر ولا تُبتلع

`LuceneBridge` يحتفظ بآخر أسطر stderr (`stderrTail`) ويُدرجها في الخطأ المُعاد. رسالة Java نفسها
(class مفقود، `UnsupportedClassVersionError`، فهرس مقفل) هي أنفع ما لدينا — لا ترسلها إلى سجل
debug وحده. الغطاء الاختباري: `tests/integration/javaFailures.test.ts`.

`FIQH4_JAVA_PATH` يتجاوز مسار Java المكتشف.

## البناء والفحص

```bash
npm run build:java          # → java/classes (+ java/test-classes للفهرسة الاختبارية)
npm run fixtures            # يبني فهرس Lucene حقيقيًا للمجموعة الاصطناعية — يحتاج build:java قبله
node scripts/inspect-lucene.mjs
node scripts/inspect-shamela-index.mjs
```
