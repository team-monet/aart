// @aart/registry — pack manifest/hash/import/approval-flow-wiring +
// discovery (architecture §11, spec §16/§44). See SEAMS.md for the
// governance (S4) convergence point and AMENDMENTS.md for design gaps this
// package had to fill.
export { canonicalize, computePackContentHash } from "./hash.js";
export {
  assertPackCompatibility,
  PackCompatibilityError,
  type PackRuntimeVersions,
} from "./compatibility.js";
export {
  authorPack,
  installPack,
  registerPackFiles,
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
  PackAssetMismatchError,
  parsePackManifestYaml,
  RawPackManifestSchema,
  recomputePackManifest,
  type RawPackManifest,
} from "./manifest.js";
export {
  createFakePackageManager,
  createLinkedPackageManager,
  createNpmPackageManager,
  PackageNotFoundError,
  type InstalledPackageFiles,
  type PackageManagerAdapter,
} from "./package-manager.js";
export {
  findBlocks,
  fetchRemoteRegistryIndex,
  searchLocalCatalog,
  searchRemotePacks,
  searchRemoteIndex,
  searchRemoteWorkflows,
  searchWorkflows,
  type BlockCatalogEntry,
  type BlockSearchResult,
  type DiscoveryScope,
  type FindBlocksInput,
  type RemoteRegistryIndexEntry,
  type RemoteRegistryIndexDocument,
  type PackCompatibility,
  type PackSearchResult,
  RemoteRegistryIndexError,
  type WorkflowSearchResult,
} from "./discovery.js";
export { computePackSealChecks, type PackSealCheck, type PackVersionRef } from "./pack-seal.js";
export {
  approveInstalledPack,
  listInstalledPackStatesSync,
  listActiveApprovedPackStatesSync,
  loadApprovedPackBlocksSync,
  loadBlockImplementationFileSync,
  loadBlockImplementationSource,
  loadBlockImplementationSourceSync,
  loadInstalledPackBlocks,
  loadInstalledPackBlocksSync,
  persistInstalledPack,
  readInstalledPackState,
  withPackMutationLock,
  readInstalledPackSync,
  InvalidPackAssetNameError,
  PackBlockLoadError,
  PackInstallConflictError,
  PackSealBrokenError,
  type InstalledPack,
  type InstalledPackState,
  type PackProvenance,
} from "./installed.js";
