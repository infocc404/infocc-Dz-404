# إعداد البريد في Supabase (خطوات يدوية)

الموقع لا يستطيع تغيير إعدادات Supabase بنفسه. هذه الخطوات تُنفَّذ مرة واحدة من لوحة Supabase.

رابط الموقع الحقيقي: `https://infocc404.github.io/info_cc_404/` (لاحظ الشرطة السفلية `_`).

## 1) رابط الموقع (ضروري لرابط استرجاع كلمة المرور)
**Authentication → URL Configuration**
- **Site URL**: `https://infocc404.github.io/info_cc_404/`
- **Redirect URLs**: أضف نفس الرابط، ثم **Save**.

## 2) إرسال الإيميلات لكل الطلبة (SMTP خاص)
خدمة البريد الافتراضية في Supabase للتجربة فقط: ترسل لعناوين فريق المشروع وبحد أدنى جدا في الساعة، لذلك لا تصل الرسائل للطلبة.

1. أنشئ حساب مجاني في Brevo (بلا بطاقة بنكية) وأكد بريدك.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: أضف بريد المرسل وأكده بالكود. (لا تستعمل خيار Domains.)
3. **SMTP & API → SMTP → Generate a new SMTP key**: انسخ المفتاح فورا (يظهر مرة واحدة). لا تشاركه مع أحد.
4. في Supabase: **Authentication → Emails → SMTP Settings**، فعّل **Enable custom SMTP** وعمّر:
   - Sender email: نفس بريد المرسل المؤكد في Brevo
   - Sender name: `info cc 404`
   - Host: `smtp-relay.brevo.com`
   - Port: `587`
   - Username: الـ Login الظاهر في صفحة SMTP في Brevo (بصيغة `xxxx@smtp-brevo.com`)
   - Password: الـ SMTP key
5. **Save**، ثم جرّب "نسيت كلمة المرور" ببريد ليس بريدك. افحص Spam أيضا.

## 3) إلغاء تأكيد البريد عند التسجيل (موصى به)
**Authentication → Sign In / Providers → Email → Confirm email**: طفّئه، فيدخل الطالب مباشرة بعد التسجيل بدون انتظار رسالة. بريد Brevo يبقى لاسترجاع كلمة المرور فقط، وحد الإرسال (30 في الساعة) يكفي.

## 4) كلمة مرور طالب منسية والبريد لا يعمل
يمكن للمالك تعديل المستخدم من **Authentication → Users** في Supabase.
