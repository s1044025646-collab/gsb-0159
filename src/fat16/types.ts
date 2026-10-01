/** Domain types shared by the FAT16 parser, scanner and storage layer. */

export interface BpbParams {
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  numFats: number;
  rootEntries: number;
  totalSectors16: number;
  media: number;
  fatSize16: number;
  totalSectors32: number;
  oemName: string;
  volumeLabel: string;
}

export interface VolumeLayout {
  imageSize: number;
  totalSectors: number;
  fatStartSector: number;
  fatSizeSectors: number;
  rootStartSector: number;
  rootDirSectors: number;
  dataStartSector: number;
  clusterCount: number;
  firstDataSector: number;
  totalDataSectors: number;
}

export type DirEntryKind =
  | "file"
  | "directory"
  | "volume-label"
  | "lfn-slot"
  | "deleted"
  | "dot"
  | "dotdot"
  | "free";

export interface DirectoryEntry {
  kind: DirEntryKind;
  /** Short file name rendered as 8.3 (uppercase, no padding). */
  shortName: string | null;
  /** Raw 11-byte 8.3 field, kept as evidence. */
  rawName: string | null;
  attr: number;
  isReadOnly: boolean;
  isHidden: boolean;
  isSystem: boolean;
  isArchive: boolean;
  firstCluster: number;
  fileSize: number;
  /** Byte offset of this 32-byte entry within the image. */
  offset: number;
  /** Directory cluster this entry belongs to (0 for fixed root). */
  parentCluster: number;
  /** Absolute path reconstructed during the tree walk. */
  path: string;
  deleted: boolean;
  lfnSequence: number | null;
  createTime: number | null;
  modifyDate: number | null;
}

export type IssueCode =
  | "IMAGE_TRUNCATED"
  | "INVALID_BPB"
  | "LAYOUT_OUT_OF_BOUNDS"
  | "FAT_COPY_CONFLICT"
  | "FAT_OUT_OF_BOUNDS"
  | "BAD_CLUSTER"
  | "CHAIN_LOOP"
  | "CROSS_LINKED"
  | "CHAIN_TRUNCATED"
  | "ORPHAN_CLUSTER"
  | "ROOT_SLOT_OVERFLOW";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Byte offset into the image that proves the issue, when known. */
  offset: number | null;
  cluster?: number;
  extra?: Record<string, number | string>;
}

export interface ChainTrace {
  startCluster: number;
  expectedClusters: number;
  clusters: number[];
  terminator: number | null;
  issues: Issue[];
}

export interface ScanResult {
  bpb: BpbParams;
  layout: VolumeLayout;
  entries: DirectoryEntry[];
  chains: Map<number, ChainTrace>;
  issues: Issue[];
  /** Number of distinct data clusters referenced by directory chains. */
  allocatedClusters: number;
  /** Data clusters that FAT marks allocated but no directory reaches. */
  orphanClusters: number[];
  /** FAT value per copy: copies[copyIndex][clusterIndex]. */
  fatCopies: number[][];
  /** Per-cluster owning start cluster (cross-link evidence). */
  ownerByCluster: Map<number, number>;
}
