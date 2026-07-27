import type { Metadata } from "next";
import { CatalogApp } from "../../catalog-app";
import { catalogDocument, packLabel } from "../../../lib/catalog";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ packName: string }>;
}): Promise<Metadata> {
  const { packName } = await params;
  const pack = catalogDocument.packs.find((candidate) => candidate.packName === packName);
  return {
    title: pack ? packLabel(pack) : "Pack not found",
    description: pack?.description,
  };
}

export default async function PackPage({
  params,
}: {
  params: Promise<{ packName: string }>;
}) {
  const { packName } = await params;
  return <CatalogApp initialPackName={packName} />;
}
