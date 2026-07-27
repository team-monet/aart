import type { Metadata } from "next";
import { CatalogApp } from "../../catalog-app";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  return {
    title: `${category.replaceAll("-", " ")} Packs`,
    description: `Browse reusable AART Packs in ${category.replaceAll("-", " ")}.`,
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  return <CatalogApp initialCategory={category} />;
}
