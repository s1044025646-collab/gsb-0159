/**
 * Shared type definitions for FAT16 parsing, image synthesis, checks and persistence.
 */

export interface VolumeParams {
  oemName: string;
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  numberOfFats: number;
  rootEntryCount: number;
  totalSectors16: number;
  media: number;
  fatSize16: number;
  sectorsPerTrack: number;
  numberOfHeads: number;
  hiddenSectors: number;
  totalSectors32: number;
  /** Derived */
  rootDirSectors: number;
  firstFatSector: number;
  rootDirSector: number;
  firstDataSector: number;
  totalClusters: number;
  fatType: "FAT16";
}

export type DirEntryKind =
  | "file"
  | "directory"
  | "volume-label"
  | "lfn-unsupported"
  | "deleted"
  | "invalid";

export interface ParsedDirEntry {
  /** Zero-based index of the 32-byte slot within its directory region. */
  slotIndex: number;
  /** Absolute byte offset of the slot inside the image. */
  offset: number;
  kind: DirEntryKind;
  /** Short name rendered as NAME.EXT, lowercasing only when the LFN-case bits request it. */
  shortName: string;
  /** Raw 8.3 bytes (first 11 bytes of the entry). */
  rawName: string;
  attributes: number;
  isReadOnly: boolean;
  isHidden: boolean;
  isSystem: boolean;
  isArchive: boolean;
  /** Modification time/date stamps as decoded raw values (injected-clock independent). */
  createTime: number | null;
  createDate: number | null;
  modifyTime: number | null;
  modifyDate: number | null;
  accessDate: number | null;
  firstCluster: number;
  fileSize: number;
  /** Parent directory full path, "" for fixed root. */
  parentPath: string;
  /** Full path using short names; LFN-backed names are flagged separately. */
  path: string;
  /** True when this entry is a slot that belongs to an unsupported long name. */
  partOfUnsupportedLfn: boolean;
  /** True when first byte is 0xE5 / 0x05 (deleted, never guessed/restored). */
  deleted: boolean;
}

export type IssueCode =
 | "LAYOUT_INVALID"
 | "NOT_FAT16"
 | "IMAGE_TRUNCATED"
 | "OFFSET_OUT_OF_BOUNDS"
 | "FAT_COPIES_DIVERGE"
 | "CHAIN_LOOP"
 | "CHAIN_CROSS_LINKED"
 | "CHAIN_TRUNCATED"
 | "BAD_CLUSTER_REFERENCED"
 | "CLUSTER_INDEX_OUT_OF_RANGE"
 | "ORPHAN_ALLOCATED_CLUSTER"
 | "SIZE_CLUSTER_MISMATCH"
 | "LFN_UNSUPPORTED"
 | "DELETED_ENTRY_PRESENT";

export type Severity = "error" | "warning" | "info";

export interface CheckIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Byte/sector/cluster references that pin the problem to a concrete location. */
  offset?: number;
  sector?: number;
  cluster?: number;
  path?: string;
  /** Conflict evidence when FAT copies disagree: both raw values are retained. */
  evidence?: Record<string, unknown>;
}

export interface ClusterOccupancy {
  cluster: number;
  status: "free" | "reserved" | "bad" | "eoc" | "allocated";
  fatValues: number[];
  /** Owner path once directory traversal resolves the chain; null for orphans. */
  ownerPath: string | null;
  fatCopyIndex?: number;
}

export interface ChainTrace {
  path: string;
  firstCluster: number;
  expectedClustersFromSize: number;
  chain: number[];
  terminated: boolean;
  issues: CheckIssue[];
}

export interface ParseResult {
  imagePath: string;
  imageSize: number;
  sha256: string;
  params: VolumeParams;
  fatCopies: Uint16Array[];
  entries: ParsedDirEntry[];
  clusters: ClusterOccupancy[];
  chains: ChainTrace[];
  issues: CheckIssue[];
  /** Millisecond timestamp provided by the caller (injectable clock). */
  parsedAt: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
