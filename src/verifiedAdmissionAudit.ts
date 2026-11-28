/**
 * Verified AY 2027–2028 Undergraduate Admission Information & Schedule Audit
 * for all 15 universities in UniMatch PH.
 *
 * Last verified: 2026-11-27
 *
 * Accuracy guarantees:
 * - Every dated event below (`verification_status: "verified"`) was confirmed
 *   directly from an official university `.edu.ph` admissions page or official
 *   applicant portal for AY 2027–2028.
 * - No AY 2025–2026 or AY 2026–2027 dates are carried over as current.
 * - Multiple examination batches and separate deadlines (e.g., UST LEAPMed vs.
 *   Regular College, DLSU Manila vs. Online vs. Laguna DCAT batches) are
 *   recorded as individual structured events for calendar precision.
 * - Universities that have not published fixed AY 2027–2028 schedules on their
 *   official websites are recorded with `verification_status: "tba"` and
 *   `start_date: null`, displayed explicitly as "Not Yet Announced".
 */
import type {
  AdmissionEventType,
  VerificationStatus,
} from "./admissionScheduleStore.js";

export type OfficialAdmissionStatus =
  | "Open"
  | "Upcoming"
  | "Closed"
  | "Not Yet Announced";

export interface UniversityAdmissionAuditMeta {
  university_id: string;
  academic_year: string;
  admission_status: OfficialAdmissionStatus;
  official_admissions_url: string;
  official_portal_url: string | null;
  last_verified_date: string;
  status_note: string;
}

export interface AuditedAdmissionEventSeed {
  event_id: string;
  university_id: string;
  event_name: string;
  event_type: AdmissionEventType;
  academic_year: string;
  start_date: string | null;
  end_date: string | null;
  exam_time: string | null;
  venue: string | null;
  official_source_url: string;
  description: string;
  verification_status: VerificationStatus;
  last_updated_at: string;
}

export const AUDIT_VERIFIED_DATE = "2026-11-27";
export const AUDIT_VERIFIED_ISO = "2026-11-27T00:00:00Z";
export const AUDIT_ACADEMIC_YEAR = "AY 2027–2028";

export const UNIVERSITY_ADMISSION_AUDIT_META: Record<
  string,
  UniversityAdmissionAuditMeta
> = {
  "dlsu-manila": {
    university_id: "dlsu-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Closed",
    official_admissions_url:
      "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
    official_portal_url:
      "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Term 1 AY 2027–2028 application period ended (July 15 – Sept 30, 2026; extended window through Oct 7, 2026). Online and Laguna DCAT testing batches continue through Dec 11, 2026.",
  },
  "ust-manila": {
    university_id: "ust-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Open",
    official_admissions_url: "https://ofad.ust.edu.ph/",
    official_portal_url: "https://ustet.ust.edu.ph/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "USTET AY 2027–2028 Regular College applications are open until January 8, 2027. College with LEAPMed closes November 27, 2026.",
  },
  "up-manila": {
    university_id: "up-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Closed",
    official_admissions_url: "https://www.upm.edu.ph/admissions-undergraduate/",
    official_portal_url: "https://upcat2027online.up.edu.ph/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "UPCAT 2027 (for AY 2027–2028) application and August 1–2, 2026 examination have concluded. Official results release date is Not Yet Announced.",
  },
  "ceu-manila": {
    university_id: "ceu-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Open",
    official_admissions_url:
      "https://www.ceu.edu.ph/static/admission-subpages/15.html",
    official_portal_url:
      "https://admissionsapplicationundergraduate.netlify.app/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "CEU Manila S.Y. 2027–2028 undergraduate online applications are open on a rolling basis; fixed cutoff and examination dates are Not Yet Announced.",
  },
  "lpu-manila": {
    university_id: "lpu-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Open",
    official_admissions_url: "https://manila.lpu.edu.ph/admissions/",
    official_portal_url: "https://apply.lpu.edu.ph/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "LPU Manila online application portal accepts AY 2027–2028 intakes on a rolling basis (LCET waived except for BS Accountancy and BS Customs Administration); fixed deadlines are Not Yet Announced.",
  },
  "feu-manila": {
    university_id: "feu-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url:
      "https://www.feu.edu.ph/admissions/freshmen-application/",
    official_portal_url:
      "https://fareasternuniversity.my.salesforce-sites.com/leadform",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "FEU uses self-booked FEUCAT schedules on its application portal (results released 2 weeks after booked exam); no fixed AY 2027–2028 deadline or exam calendar is published.",
  },
  "mapua-manila": {
    university_id: "mapua-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url:
      "https://www.mapua.edu.ph/admissions/application-guidelines/undergraduate/",
    official_portal_url: "https://admissions.mapua.edu.ph/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Mapúa administers rolling online MPASS via Cardinal EDGE, while its homepage banner still displays AY 2026–2027; official AY 2027–2028 deadlines are Not Yet Announced.",
  },
  "adamson-manila": {
    university_id: "adamson-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.adamson.edu.ph/v1/?page=freshmen",
    official_portal_url: "https://www.adamson.edu.ph/aducet/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Applicants choose an AdUCET slot via the Adamson portal once approved; fixed AY 2027–2028 application deadlines and exam dates are Not Yet Announced.",
  },
  "pup-sta-mesa": {
    university_id: "pup-sta-mesa",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.pup.edu.ph/iapply/pupcet",
    official_portal_url: "https://www.pup.edu.ph/iapply/pupcet",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Official PUP iApply page currently reflects AY 2026–2027 (closed); AY 2027–2028 PUPCET dates are Not Yet Announced.",
  },
  "ue-manila": {
    university_id: "ue-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.ue.edu.ph/mla/about-admission/",
    official_portal_url: "https://apps.ue.edu.ph/onlineadmission/main.html",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "UE Manila admission announcements currently cover SY 2026–2027; AY 2027–2028 CET and application dates are Not Yet Announced.",
  },
  "sanbeda-manila": {
    university_id: "sanbeda-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.sanbeda.edu.ph/",
    official_portal_url: null,
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Previous /manila/admissions URL returned 404 and AIMS portal was unreachable during audit; AY 2027–2028 admission dates are Not Yet Announced.",
  },
  "tup-manila": {
    university_id: "tup-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.tup.edu.ph/page/admission",
    official_portal_url: "https://ers.tup.edu.ph/aims/applicants/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Official TUP admission pages and ERS Applicant Portal do not yet publish fixed AY 2027–2028 TUPSTAT deadlines or testing dates.",
  },
  "pnu-manila": {
    university_id: "pnu-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.pnu.edu.ph/admissions/",
    official_portal_url: "https://pwebss.pnu.edu.ph/pnu/applicants/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Official PNU admissions page does not yet publish verified AY 2027–2028 PNUAT schedules (unverified third-party dates are excluded).",
  },
  "plm-manila": {
    university_id: "plm-manila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://www.plm.edu.ph/admissions/",
    official_portal_url: "https://plm.pinnacle.edu.ph/aims/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "PLM AIMS Admission InfoSys currently shows online application closed; AY 2027–2028 PLMAT dates are Not Yet Announced.",
  },
  spumanila: {
    university_id: "spumanila",
    academic_year: AUDIT_ACADEMIC_YEAR,
    admission_status: "Not Yet Announced",
    official_admissions_url: "https://spumanila.edu.ph/college-admission/",
    official_portal_url:
      "https://spumanila.edu.ph/apply-to-st-paul-university-manila/",
    last_verified_date: AUDIT_VERIFIED_DATE,
    status_note:
      "Official SPU Manila college admission page currently lists Second Semester AY 2026–2027 (no entrance examination required); AY 2027–2028 dates are Not Yet Announced.",
  },
};

export const VERIFIED_AUDIT_EVENTS_AY_2027_2028: readonly AuditedAdmissionEventSeed[] =
  [
    // =========================================================================
    // 1. De La Salle University (DLSU) — AY 2027–2028 (Term 1)
    // Verified from: https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/
    // =========================================================================
    {
      event_id: "audit-2728-dlsu-app-open",
      university_id: "dlsu-manila",
      event_name: "DLSU Freshman Online Application Opens (Term 1)",
      event_type: "application_open",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-07-15",
      end_date: null,
      exam_time: null,
      venue: "Online via DLSU Archers Hub",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Official opening of first-year undergraduate college applications for AY 2027–2028 Term 1 through the DLSU Archers Hub.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-app-deadline",
      university_id: "dlsu-manila",
      event_name: "DLSU Freshman Application Deadline (Term 1)",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-09-30",
      end_date: null,
      exam_time: null,
      venue: "Online via DLSU Archers Hub",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Published AY 2027–2028 Term 1 application closing date (September 30, 2026; DLSU portal also noted an extended application filing window through October 7, 2026).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-manila-b1",
      university_id: "dlsu-manila",
      event_name: "DCAT — Manila Campus Testing Batch 1",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-11-08",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "DLSU Manila Campus, Taft Avenue, Malate, Manila",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "First on-site Manila campus testing date for the De La Salle University College Admission Test (DCAT) for AY 2027–2028 Term 1.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-manila-b2",
      university_id: "dlsu-manila",
      event_name: "DCAT — Manila Campus Testing Batch 2",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-11-15",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "DLSU Manila Campus, Taft Avenue, Malate, Manila",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Second on-site Manila campus testing date for the De La Salle University College Admission Test (DCAT) for AY 2027–2028 Term 1.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-online-b1",
      university_id: "dlsu-manila",
      event_name: "DCAT — Online Testing Batch 1",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-11-27",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "Online Testing (Official DLSU Testing Platform)",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "First official online DCAT examination batch for AY 2027–2028 Term 1 applicants.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-online-b2",
      university_id: "dlsu-manila",
      event_name: "DCAT — Online Testing Batch 2",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-12-04",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "Online Testing (Official DLSU Testing Platform)",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Second official online DCAT examination batch for AY 2027–2028 Term 1 applicants.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-laguna",
      university_id: "dlsu-manila",
      event_name: "DCAT — Laguna Campus Testing Batch",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-12-04",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "DLSU Laguna Campus",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Official on-site DCAT examination schedule at the DLSU Laguna Campus for AY 2027–2028 Term 1.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-dcat-online-b3",
      university_id: "dlsu-manila",
      event_name: "DCAT — Online Testing Batch 3",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-12-11",
      end_date: null,
      exam_time: "Per official DCAT test permit",
      venue: "Online Testing (Official DLSU Testing Platform)",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Third official online DCAT examination batch for AY 2027–2028 Term 1 applicants.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-dlsu-results",
      university_id: "dlsu-manila",
      event_name: "DLSU DCAT AY 2027–2028 Results Release",
      event_type: "results_release",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via DLSU Archers Hub",
      official_source_url:
        "https://www.dlsu.edu.ph/admission/admissions-undergraduate-first-year-college-application/",
      description:
        "Exact AY 2027–2028 DCAT results release date is Not Yet Announced. Check the official DLSU undergraduate admissions page and Archers Hub for release advisories.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },

    // =========================================================================
    // 2. University of Santo Tomas (UST) — AY 2027–2028
    // Verified directly from: https://ofad.ust.edu.ph/ustet-application-for-a-y-2027-2028/
    // and https://ustet.ust.edu.ph/
    // =========================================================================
    {
      event_id: "audit-2728-ust-app-open",
      university_id: "ust-manila",
      event_name: "USTET College & LEAPMed Online Application Opens",
      event_type: "application_open",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-08-08",
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Application Portal (ustet.ust.edu.ph)",
      official_source_url:
        "https://ofad.ust.edu.ph/ustet-application-for-a-y-2027-2028/",
      description:
        "Official opening date of AY 2027–2028 online applications for UST College (open Aug 8, 2026 – Jan 8, 2027) and College with LEAPMed (open Aug 8 – Nov 27, 2026).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-b1-pay",
      university_id: "ust-manila",
      event_name: "USTET Manila Batch 1 Payment Deadline (College & LEAPMed)",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-10-09",
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Portal",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Payment deadline for the October 18, 2026 USTET Manila testing batch (College and College with LEAPMed).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-exam-b1",
      university_id: "ust-manila",
      event_name: "USTET Manila Testing Batch 1 (College & LEAPMed)",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-10-18",
      end_date: null,
      exam_time: "System-generated (LEAPMed: USTET AM, LEAPMed Exam PM)",
      venue: "UST Manila Campus, España Boulevard, Sampaloc, Manila",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "First AY 2027–2028 USTET Manila testing date for College and College with LEAPMed applicants. Testing time is system-generated on the test permit.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-leapmed-deadline",
      university_id: "ust-manila",
      event_name: "USTET College with LEAPMed Application & Payment Deadline",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-11-27",
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Portal",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Final AY 2027–2028 application, processing, and payment deadline for College with LEAPMed applicants (Manila testing center window: Oct 18 – Nov 27, 2026).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-b2-pay",
      university_id: "ust-manila",
      event_name: "USTET Manila Batch 2 Payment Deadline (College)",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-12-02",
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Portal",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Payment deadline to be assigned to the December 6, 2026 USTET Manila testing batch for College applicants.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-exam-b2",
      university_id: "ust-manila",
      event_name: "USTET Manila Testing Batch 2 (College & LEAPMed)",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-12-06",
      end_date: null,
      exam_time: "System-generated (LEAPMed: USTET AM, LEAPMed Exam PM)",
      venue: "UST Manila Campus, España Boulevard, Sampaloc, Manila",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Second AY 2027–2028 USTET Manila testing date for College and College with LEAPMed applicants.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-college-deadline",
      university_id: "ust-manila",
      event_name: "USTET Regular College Application & Payment Deadline",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2027-01-08",
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Portal",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Final AY 2027–2028 online application and payment deadline for Regular College applicants (covers the Jan 24, 2027 Manila College batch and Feb 14, 2027 UST Manila SHS batch).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-exam-b3",
      university_id: "ust-manila",
      event_name: "USTET Manila Testing Batch 3 (College)",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2027-01-24",
      end_date: null,
      exam_time: "System-generated per test permit",
      venue: "UST Manila Campus & St. Stephen's High School, Manila",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Third AY 2027–2028 USTET Manila testing batch for Regular College applicants (payment deadline January 8, 2027). Venue and testing time are system-generated.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-exam-ustshs",
      university_id: "ust-manila",
      event_name: "USTET Manila Testing Batch (UST Manila SHS Applicants)",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2027-02-14",
      end_date: null,
      exam_time: "System-generated per test permit",
      venue: "UST Manila Campus, España Boulevard, Sampaloc, Manila",
      official_source_url: "https://ustet.ust.edu.ph/",
      description:
        "Dedicated AY 2027–2028 USTET College testing date for current UST Manila Senior High School students (payment deadline January 8, 2027).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ust-results",
      university_id: "ust-manila",
      event_name: "USTET AY 2027–2028 Results Release",
      event_type: "results_release",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via USTET Results Portal (ustet.ust.edu.ph/results)",
      official_source_url: "https://ustet.ust.edu.ph/results/",
      description:
        "Exact release date is Not Yet Announced. Official USTET portal states that AY 2027–2028 results shall be announced in the Second Quarter of 2027.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },

    // =========================================================================
    // 3. University of the Philippines Manila (UP Manila) — UPCAT 2027 (AY 2027–2028)
    // Verified from: https://upcat.up.edu.ph/ & https://upcat2027online.up.edu.ph/
    // =========================================================================
    {
      event_id: "audit-2728-upm-app-open",
      university_id: "up-manila",
      event_name: "UPCAT 2027 Online Application Opens (Form 1)",
      event_type: "application_open",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-03-03",
      end_date: null,
      exam_time: null,
      venue: "Online via UPCAT 2027 Portal (upcat2027online.up.edu.ph)",
      official_source_url: "https://upcat.up.edu.ph/",
      description:
        "Opening of UPCAT 2027 (for AY 2027–2028 freshman intake) online student registration and Form 1 submission across all UP campuses including UP Manila.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-upm-app-deadline",
      university_id: "up-manila",
      event_name: "UPCAT 2027 Online Application Deadline (Form 1)",
      event_type: "application_deadline",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-03-30",
      end_date: null,
      exam_time: null,
      venue: "Online via UPCAT 2027 Portal (upcat2027online.up.edu.ph)",
      official_source_url: "https://upcat2027online.up.edu.ph/",
      description:
        "Official closing date for UPCAT 2027 Form 1 student applications for AY 2027–2028.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-upm-form2a",
      university_id: "up-manila",
      event_name: "UPCAT 2027 School Form 2A Confirmation Window",
      event_type: "other",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-03-03",
      end_date: "2026-04-10",
      exam_time: null,
      venue: "Online via UPCAT 2027 School Portal",
      official_source_url: "https://upcat.up.edu.ph/",
      description:
        "Official initial window for high schools to confirm applicants' Form 2A records (extended document submission remained open until September 21, 2026).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-upm-upcat-exam",
      university_id: "up-manila",
      event_name: "UPCAT 2027 Entrance Examination",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-08-01",
      end_date: "2026-08-02",
      exam_time: "Morning & Afternoon Sessions (per Test Permit)",
      venue: "Assigned UP System & Regional Testing Centers",
      official_source_url: "https://upcat.up.edu.ph/",
      description:
        "Official two-day University of the Philippines College Admission Test (UPCAT 2027) for AY 2027–2028 intake.",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-upm-form2b",
      university_id: "up-manila",
      event_name: "UPCAT 2027 Grades Submission (Form 2B — Extended Window)",
      event_type: "other",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: "2026-08-03",
      end_date: "2026-09-21",
      exam_time: null,
      venue: "Online via UPCAT 2027 Portal",
      official_source_url: "https://upcat.up.edu.ph/",
      description:
        "Grades verification and Form 2B submission period (initial window Aug 3–24, 2026; officially extended through September 21, 2026).",
      verification_status: "verified",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-upm-results",
      university_id: "up-manila",
      event_name: "UPCAT 2027 (AY 2027–2028) Results Release",
      event_type: "results_release",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via Official UPCAT Portal (upcat.up.edu.ph)",
      official_source_url: "https://upcat.up.edu.ph/",
      description:
        "Exact UPCAT 2027 results release date is Not Yet Announced. Monitor https://upcat.up.edu.ph/ and https://www.upm.edu.ph/admissions-undergraduate/ for official announcements.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },

    // =========================================================================
    // 4–15. Remaining 12 Universities — Official AY 2027–2028 Fixed Dates Not Yet
    // Announced (Strictly marked `tba` / "Not Yet Announced", zero invented dates)
    // =========================================================================
    {
      event_id: "audit-2728-ceu-tba",
      university_id: "ceu-manila",
      event_name: "CEU Manila AY 2027–2028 Undergraduate Admissions",
      event_type: "application_open",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via CEU Undergraduate Application Portal",
      official_source_url:
        "https://www.ceu.edu.ph/static/admission-subpages/15.html",
      description:
        "Current Status: Open (Rolling). Official CEU Manila page advertises S.Y. 2027–2028 online applications via https://admissionsapplicationundergraduate.netlify.app/, but fixed application deadlines and examination dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-lpu-tba",
      university_id: "lpu-manila",
      event_name: "LPU Manila AY 2027–2028 Admissions & LCET Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via LPU Application Portal (apply.lpu.edu.ph)",
      official_source_url: "https://apply.lpu.edu.ph/",
      description:
        "Current Status: Open (Rolling). LPU's official application portal accepts AY 2027–2028 intakes (LCET is waived for all programs except BS Accountancy and BS Customs Administration). Fixed cutoff and exam dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-feu-tba",
      university_id: "feu-manila",
      event_name: "FEU-CAT AY 2027–2028 Examination & Application Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Self-booked via FEU Application Portal",
      official_source_url:
        "https://www.feu.edu.ph/admissions/freshmen-application/",
      description:
        "Applicants self-book their preferred FEUCAT schedule on the FEU portal after payment validation, with results released 2 weeks after the booked test date. Fixed AY 2027–2028 deadlines and test dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-mapua-tba",
      university_id: "mapua-manila",
      event_name: "Mapúa MPASS & AY 2027–2028 Application Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Online via Mapúa Admissions Portal & Cardinal EDGE",
      official_source_url:
        "https://www.mapua.edu.ph/admissions/application-guidelines/undergraduate/",
      description:
        "Mapúa uses rolling 'Anytime, Anywhere' online MPASS assessments via https://admissions.mapua.edu.ph/, while its homepage banner still displays AY 2026–2027. Official AY 2027–2028 fixed deadlines are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-adamson-tba",
      university_id: "adamson-manila",
      event_name: "Adamson University AdUCET AY 2027–2028 Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "Adamson University, Ermita, Manila / AdUCET Portal",
      official_source_url: "https://www.adamson.edu.ph/aducet/",
      description:
        "Applicants choose an available AdUCET testing schedule through the Adamson portal after application approval. Fixed AY 2027–2028 application deadlines and exam dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-pup-tba",
      university_id: "pup-sta-mesa",
      event_name: "PUPCET AY 2027–2028 Application & Examination Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "PUP Sta. Mesa, Manila",
      official_source_url: "https://www.pup.edu.ph/iapply/pupcet",
      description:
        "Official PUP iApply page currently reflects AY 2026–2027 (application closed). AY 2027–2028 PUPCET application and examination dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-ue-tba",
      university_id: "ue-manila",
      event_name: "UE Manila CET & AY 2027–2028 Freshman Admissions",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "UE Manila Campus / Online Admission Portal",
      official_source_url: "https://www.ue.edu.ph/mla/about-admission/",
      description:
        "Official UE Manila admission announcements still list SY 2026–2027 advisories. AY 2027–2028 CET and freshman application dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-sanbeda-tba",
      university_id: "sanbeda-manila",
      event_name: "San Beda University Manila AY 2027–2028 Admissions & Exam",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "San Beda University, Mendiola, Manila",
      official_source_url: "https://www.sanbeda.edu.ph/",
      description:
        "Official AY 2027–2028 undergraduate admission and entrance examination dates are Not Yet Announced. Note: San Beda's legacy /manila/admissions URL returned 404 during audit; verify directly at https://www.sanbeda.edu.ph/ or via SBUadmissions@sanbeda.edu.ph.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-tup-tba",
      university_id: "tup-manila",
      event_name: "TUPSTAT AY 2027–2028 Application & Examination Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "TUP Manila Campus / ERS Applicant Portal",
      official_source_url: "https://www.tup.edu.ph/page/admission",
      description:
        "Official TUP admissions pages and ERS Applicant Portal (https://ers.tup.edu.ph/aims/applicants/) have not yet published fixed AY 2027–2028 TUPSTAT application deadlines or examination dates.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-pnu-tba",
      university_id: "pnu-manila",
      event_name: "PNUAT AY 2027–2028 Application & Examination Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "PNU Manila Campus / PWEBSS Portal",
      official_source_url: "https://www.pnu.edu.ph/admissions/",
      description:
        "Official PNU admissions page (https://www.pnu.edu.ph/admissions/) and PWEBSS portal have not published verified AY 2027–2028 PNUAT dates. Unconfirmed third-party dates are excluded until officially announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-plm-tba",
      university_id: "plm-manila",
      event_name: "PLMAT AY 2027–2028 Application & Examination Schedule",
      event_type: "entrance_exam",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "PLM Campus, Intramuros, Manila / AIMS Portal",
      official_source_url: "https://plm.pinnacle.edu.ph/aims/",
      description:
        "PLM AIMS Admission InfoSys currently shows online application closed. Official AY 2027–2028 PLMAT application and examination dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
    {
      event_id: "audit-2728-spum-tba",
      university_id: "spumanila",
      event_name: "SPU Manila AY 2027–2028 Freshman Admissions",
      event_type: "application_open",
      academic_year: AUDIT_ACADEMIC_YEAR,
      start_date: null,
      end_date: null,
      exam_time: null,
      venue: "St. Paul University Manila, Malate, Manila",
      official_source_url: "https://spumanila.edu.ph/college-admission/",
      description:
        "No entrance examination required. Official college admission page currently lists Second Semester AY 2026–2027; AY 2027–2028 freshman application dates are Not Yet Announced.",
      verification_status: "tba",
      last_updated_at: AUDIT_VERIFIED_ISO,
    },
  ];
