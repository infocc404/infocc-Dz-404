import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    try {
      if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
      const body = await req.json();
      const { userId, action } = body ?? {};
      if (typeof userId !== "string" || !["suspend", "activate"].includes(action)) {
        return Response.json({ error: "بيانات الطلب غير صحيحة." }, { status: 400 });
      }

      const { data: roleData, error: roleError } = await ctx.supabase.rpc("my_role");
      if (roleError) {
        console.error("Role check failed:", roleError.message);
        return Response.json({ error: "تعذر التحقق من صلاحياتك." }, { status: 403 });
      }
      const role = Array.isArray(roleData)
        ? (roleData[0]?.user_role ?? roleData[0])
        : (roleData?.user_role ?? roleData);
      if (role !== "owner") {
        return Response.json({ error: "إدارة الحسابات متاحة لمالك المنصة فقط." }, { status: 403 });
      }

      const { data: target, error: targetError } = await ctx.supabaseAdmin.auth.admin.getUserById(userId);
      if (targetError || !target?.user) return Response.json({ error: "لم يتم العثور على الحساب." }, { status: 404 });
      if (target.user.id === ctx.user.id || (target.user.email ?? "").toLowerCase() === "locoviber16@gmail.com") {
        return Response.json({ error: "حساب المالك محمي ولا يمكن إيقافه." }, { status: 403 });
      }

      const { error: updateError } = await ctx.supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: action === "suspend" ? "876000h" : "none"
      });
      if (updateError) {
        console.error("Account update failed:", updateError.message);
        return Response.json({ error: "تعذر تحديث حالة الحساب." }, { status: 500 });
      }
      return Response.json({ success: true, message: action === "suspend" ? "تم إيقاف الحساب بنجاح." : "تم تفعيل الحساب بنجاح." });
    } catch (error) {
      console.error("manage-user-access error:", error);
      return Response.json({ error: "حدث خطأ داخلي أثناء إدارة الحساب." }, { status: 500 });
    }
  })
};
