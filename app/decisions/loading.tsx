import { SkeletonRows } from "@/components/threads/Skeletons";

/** Decisions loading state: skeleton list (SITE_CONTRACT §2.14). */
export default function DecisionsLoading() {
  return <SkeletonRows count={3} label="Loading decisions" />;
}
