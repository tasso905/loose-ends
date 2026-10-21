import { SkeletonRows } from "@/components/threads/Skeletons";

/** Today loading state: three skeleton rows (SITE_CONTRACT §2.14). */
export default function TodayLoading() {
  return <SkeletonRows count={3} label="Loading Today" />;
}
