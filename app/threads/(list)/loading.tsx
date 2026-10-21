import { SkeletonRows } from "@/components/threads/Skeletons";

/** Threads loading state: skeleton rows (SITE_CONTRACT §2.14). */
export default function ThreadsLoading() {
  return <SkeletonRows count={4} label="Loading threads" />;
}
