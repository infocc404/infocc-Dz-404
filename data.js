// ============================================================================
// info cc 404 — Academic data (data.js)
// Only the list of official subjects lives here.
// Teachers  -> table teacher_info   (managed by owner/admin in the app)
// Timetable -> table schedule_entries (managed by owner/admin in the app)
// ============================================================================

// 1. قائمة المقاييس السبعة المعتمدة رسمياً في السداسي 1
const SUBJECTS = [
  {
    id: "algo",
    nameFr: "Algo & SDS 1",
    nameAr: "الخوارزميات وهياكل المعطيات 1",
    nameEn: "Algorithms and Data Structures 1",
    aliases: [
      "algo", "algo 1", "algorithmique", "sds", "sds 1", "algo & sds",
      "algo & sds 1", "asd", "asd1", "structures de données", "الخوارزميات"
    ]
  },
  {
    id: "arch",
    nameFr: "Comp Arch 1",
    nameAr: "بنية الحاسوب 1",
    nameEn: "Computer Architecture 1",
    aliases: [
      "arch", "arch 1", "comp arch", "comp arch 1", "architecture",
      "archi", "architecture des ordinateurs", "بنية الحاسوب"
    ]
  },
  {
    id: "sys",
    nameFr: "Operating Sys 1",
    nameAr: "نظام التشغيل 1",
    nameEn: "Operating Systems 1",
    aliases: [
      "sys", "sys 1", "operating sys", "operating sys 1", "systeme",
      "systemes", "système", "os", "se", "système d'exploitation", "نظام التشغيل"
    ]
  },
  {
    id: "analyse",
    nameFr: "Math Analysis 1",
    nameAr: "التحليل الرياضي 1",
    nameEn: "Mathematical Analysis 1",
    aliases: [
      "analyse", "analyse 1", "analysis", "math analysis", "math analysis 1",
      "maths", "math 1", "التحليل", "التحليل الرياضي"
    ]
  },
  {
    id: "algebre",
    nameFr: "Algebra 1",
    nameAr: "الجبر 1",
    nameEn: "Algebra 1",
    aliases: [
      "algebre", "algèbre", "algebre 1", "algèbre 1", "algebra",
      "algebra 1", "الجبر", "الجبر 1"
    ]
  },
  {
    id: "elec",
    nameFr: "Fundamental Electronics",
    nameAr: "الإلكترونيك الأساسية",
    nameEn: "Fundamental Electronics",
    aliases: [
      "elec", "electronique", "électronique", "electronics",
      "fundamental electronics", "elec fond", "الإلكترونيك", "الكترونيك"
    ]
  },
  {
    id: "histoire",
    nameFr: "History of Algeria",
    nameAr: "تاريخ الجزائر",
    nameEn: "History of Algeria",
    aliases: [
      "histoire", "histoire d'algerie", "histoire de l'algerie",
      "history", "history of algeria", "تاريخ", "تاريخ الجزائر"
    ]
  }
];

// إتاحة البيانات في window
if (typeof window !== "undefined") {
  window.SUBJECTS = SUBJECTS;
}
