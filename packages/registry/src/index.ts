// @aart/registry — pack manifest/hash/import/approval-flow-wiring +
// discovery (architecture §11, spec §16/§44). See SEAMS.md for the
// governance (S4) convergence point and AMENDMENTS.md for design gaps this
// package had to fill.
export { canonicalize, computePackContentHash } from "./hash.js";
export {
  authorPack,
  installPack,
  PackNameMismatchError,
  type AuthorPackInput,
} from "./import.js";
export {
  buildPackManifest,
  InvalidPackNameError,
  npmPackageNameFor,
  packNameFromNpmPackage,
  PACK_NPM_PREFIX,
  PackManifestParseError,
  parsePackManifestYaml,
  RawPackManifestSchema,
  recomputePackManifest,
  type RawPackManifest,
} from "./manifest.js";
export {
  createFakePackageManager,
  createLinkedPackageManager,
  PackageNotFoundError,
  type InstalledPackageFiles,
  type PackageManagerAdapter,
} from "./package-manager.js";
export {
  findBlocks,
  searchLocalCatalog,
  searchRemoteIndex,
  type BlockCatalogEntry,
  type BlockSearchResult,
  type DiscoveryScope,
  type FindBlocksInput,
  type RemoteRegistryIndexEntry,
} from "./discovery.js";
