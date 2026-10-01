import type { BpbParams, Issue, VolumeLayout } from "./types.js";

export const FAT16_MIN_CLUSTERS = 4085;
export const FAT16_MAX_CLUSTERS = 65524;

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.toString("latin1", start, start + len);
}

/** Parse the little-endian BPB without trusting any derived geometry. */
export function parseBpb(buf: Buffer): { bpb: BpbParams | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (buf.length < 512) {
    issues.push({
      code: "IMAGE_TRUNCATED",
      severity: "error",
      message: `Image is ${buf.length} bytes, smaller than a 512-byte boot sector.`,
      offset: buf.length,
    });
    return { bpb: null, issues };
  }

  const bytesPerSector = buf.readUInt16LE(11);
  const sectorsPerCluster = buf.readUInt8(13);
  const reservedSectors = buf.readUInt16LE(14);
  const numFats = buf.readUInt8(16);
  const rootEntries = buf.readUInt16LE(17);
  const totalSectors16 = buf.readUInt16LE(19);
  const media = buf.readUInt8(21);
  const fatSize16 = buf.readUInt16LE(22);
  const totalSectors32 = buf.readUInt32LE(32);
  const oemName = ascii(buf, 3, 8);
  const volumeLabel = ascii(buf, 43, 11);

  const validSectorSizes = new Set([512, 1024, 2048, 4096]);
  if (!validSectorSizes.has(bytesPerSector)) {
    issues.push(mk("INVALID_BPB", `Unsupported bytesPerSector=${bytesPerSector}.`, 11));
  }
  const pow2 = sectorsPerCluster > 0 && (sectorsPerCluster & (sectorsPerCluster - 1)) === 0;
  if (!pow2) {
    issues.push(mk("INVALID_BPB", `sectorsPerCluster=${sectorsPerCluster} is not a power of two.`, 13));
  }
  if (reservedSectors === 0) {
    issues.push(mk("INVALID_BPB", "reservedSectors must be > 0.", 14));
  }
  if (numFats === 0) {
    issues.push(mk("INVALID_BPB", "numFats must be > 0.", 16));
  }
  if (fatSize16 === 0) {
    issues.push(mk("INVALID_BPB", "FAT16 requires a non-zero 16-bit FAT size.", 22));
  }

  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;
  if (totalSectors === 0) {
    issues.push(mk("INVALID_BPB", "Total sector count is zero in both 16-bit and 32-bit fields.", 19));
  }
  const imageSectors = Math.floor(buf.length / bytesPerSector || 512);
  if (totalSectors > imageSectors) {
    issues.push(
      mk(
        "IMAGE_TRUNCATED",
        `BPB declares ${totalSectors} sectors but image only holds ${imageSectors}.`,
        imageSectors * (bytesPerSector || 512),
      ),
    );
  }

  return {
    bpb: {
      bytesPerSector,
      sectorsPerCluster,
      reservedSectors,
      numFats,
      rootEntries,
      totalSectors16,
      media,
      fatSize16,
      totalSectors32,
      oemName,
      volumeLabel,
    },
    issues,
  };
}

function mk(code: Issue["code"], message: string, offset: number): Issue {
  return { code, severity: "error", message, offset };
}

/** Compute and validate every derived sector boundary before any data access. */
export function computeLayout(buf: Buffer, bpb: BpbParams): { layout: VolumeLayout | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const spc = bpb.bytesPerSector;
  const totalSectors = bpb.totalSectors16 !== 0 ? bpb.totalSectors16 : bpb.totalSectors32;

  const fatStartSector = bpb.reservedSectors;
  const fatSizeSectors = bpb.fatSize16;
  const rootDirSectors = Math.ceil((bpb.rootEntries * 32) / spc);
  const rootStartSector = fatStartSector + bpb.numFats * fatSizeSectors;
  const firstDataSector = rootStartSector + rootDirSectors;
  const totalDataSectors = totalSectors - firstDataSector;
  const dataStartSector = firstDataSector;
  const clusterCount = Math.floor(totalDataSectors / bpb.sectorsPerCluster);

  const checks: Array<[number, number, string]> = [
    [fatStartSector, fatSizeSectors, "FAT region"],
    [rootStartSector, rootDirSectors, "root directory region"],
    [dataStartSector, totalDataSectors, "data region"],
  ];
  for (const [start, size, name] of checks) {
    if (start < 0 || size < 0 || start + size > totalSectors) {
      issues.push(
        mk(
          "LAYOUT_OUT_OF_BOUNDS",
          `${name} [sector ${start}, +${size}] exceeds ${totalSectors} sectors.`,
          Math.min(start * spc, buf.length),
        ),
      );
    }
  }

  // FAT entries needed (cluster 0/1 reserved, so entries = clusterCount + 2).
  const fatEntries = clusterCount + 2;
  const fatCapacityEntries = Math.floor((fatSizeSectors * spc) / 2);
  if (fatCapacityEntries < fatEntries) {
    issues.push(
      mk(
        "LAYOUT_OUT_OF_BOUNDS",
        `FAT of ${fatCapacityEntries} entries cannot describe ${fatEntries} entries.`,
        fatStartSector * spc,
      ),
    );
  }

  if (clusterCount < FAT16_MIN_CLUSTERS || clusterCount > FAT16_MAX_CLUSTERS) {
    issues.push(
      mk(
        "INVALID_BPB",
        `Cluster count ${clusterCount} is outside the FAT16 range ${FAT16_MIN_CLUSTERS}..${FAT16_MAX_CLUSTERS}.`,
        dataStartSector * spc,
      ),
    );
  }

  const layout: VolumeLayout = {
    imageSize: buf.length,
    totalSectors,
    fatStartSector,
    fatSizeSectors,
    rootStartSector,
    rootDirSectors,
    dataStartSector,
    clusterCount,
    firstDataSector,
    totalDataSectors,
  };
  return { layout: issues.some((i) => i.severity === "error") ? null : layout, issues };
}

export function clusterToOffset(layout: VolumeLayout, bpb: BpbParams, cluster: number): number {
  const sector = layout.firstDataSector + (cluster - 2) * bpb.sectorsPerCluster;
  return sector * bpb.bytesPerSector;
}

export function clusterByteSize(bpb: BpbParams): number {
  return bpb.sectorsPerCluster * bpb.bytesPerSector;
}
