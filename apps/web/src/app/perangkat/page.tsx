import type { Metadata } from "next";
import { Suspense } from "react";
import { AppFrame } from "@/components/shell";
import { Workspace } from "@/components/workspace/workspace";

export const metadata: Metadata = { title: "Perangkat" };

export default function PerangkatPage() {
  return (
    <AppFrame>
      <Suspense fallback={null}>
        <Workspace />
      </Suspense>
    </AppFrame>
  );
}
