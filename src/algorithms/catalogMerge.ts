/**
 * Pure catalog merge logic combining live Firestore catalog records with
 * verified baseline defaults so legacy empty placeholder documents never
 * overwrite populated baseline data while preserving all admin edits.
 */

export interface MergeableCatalogRecord {
  id: string;
  name: string;
  officialUrl: string;
  collectionStatus: "pending" | "partial" | "verified";
  collectedAt: string;
  lastVerifiedAt: string;
  programs: unknown[];
  admissionRequirements: unknown[];
  applicationDeadlines: unknown[];
  entranceExaminations: unknown[];
  tuitionFees: unknown[];
  applicationLinks: unknown[];
  sourceUrls: string[];
  sourceNotes: string[];
}

export function mergeLiveAndBaselineCatalog<T extends MergeableCatalogRecord>(
  liveRecords: T[],
  baselineRecords: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const base of baselineRecords) {
    byId.set(base.id, base);
  }

  for (const live of liveRecords) {
    const base = byId.get(live.id);
    if (!base) {
      byId.set(live.id, live);
      continue;
    }

    // Verified admin records always take full precedence over baseline defaults.
    if (live.collectionStatus === "verified") {
      byId.set(live.id, live);
      continue;
    }

    const isPendingPlaceholder = live.collectionStatus === "pending";
    const isSparseUnverified =
      (live.programs || []).length < 5 && (base.programs || []).length >= 15;

    const mergedPrograms =
      !isPendingPlaceholder && !isSparseUnverified && (live.programs || []).length > 0
        ? live.programs
        : base.programs;
    const mergedReqs =
      !isPendingPlaceholder && (live.admissionRequirements || []).length > 0
        ? live.admissionRequirements
        : base.admissionRequirements;
    const mergedExams =
      !isPendingPlaceholder && (live.entranceExaminations || []).length > 0
        ? live.entranceExaminations
        : base.entranceExaminations;
    const mergedFees =
      !isPendingPlaceholder && (live.tuitionFees || []).length > 0
        ? live.tuitionFees
        : base.tuitionFees;
    const mergedLinks =
      !isPendingPlaceholder && (live.applicationLinks || []).length > 0
        ? live.applicationLinks
        : base.applicationLinks;
    const mergedDeadlines =
      !isPendingPlaceholder && (live.applicationDeadlines || []).length > 0
        ? live.applicationDeadlines
        : base.applicationDeadlines;
    const mergedSources =
      !isPendingPlaceholder && !isSparseUnverified && (live.sourceUrls || []).length > 0
        ? live.sourceUrls
        : base.sourceUrls;
    const mergedNotes =
      !isPendingPlaceholder && !isSparseUnverified && (live.sourceNotes || []).length > 0
        ? live.sourceNotes
        : base.sourceNotes;

    const upgradedStatus =
      isPendingPlaceholder &&
      (mergedPrograms.length > 0 ||
        mergedReqs.length > 0 ||
        mergedExams.length > 0)
        ? base.collectionStatus
        : live.collectionStatus;

    byId.set(live.id, {
      ...base,
      ...live,
      collectionStatus: upgradedStatus,
      officialUrl: live.officialUrl || base.officialUrl,
      collectedAt: isPendingPlaceholder ? base.collectedAt : live.collectedAt || base.collectedAt,
      lastVerifiedAt:
        isPendingPlaceholder || isSparseUnverified
          ? base.lastVerifiedAt
          : live.lastVerifiedAt || base.lastVerifiedAt,
      programs: mergedPrograms,
      admissionRequirements: mergedReqs,
      entranceExaminations: mergedExams,
      tuitionFees: mergedFees,
      applicationLinks: mergedLinks,
      applicationDeadlines: mergedDeadlines,
      sourceUrls: mergedSources,
      sourceNotes: mergedNotes,
    });
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
