import type { Metadata } from "next";
import { CatalogApp } from "./catalog-app";

export const metadata: Metadata = {
  title: { absolute: "AART Pack Library" },
  description:
    "Find reusable Blocks and Workflows before you build another automation from scratch.",
};

export default function Home() {
  return <CatalogApp />;
}
