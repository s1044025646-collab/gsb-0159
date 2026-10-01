import type { CheckIssue, VolumeParams } from "./types.ts";

export interface BpbReadResult {
  params?: VolumeParams;
  issues: CheckIssue[];
}

function rd16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

/**
 * Decode and validate the little-endian BIOS Parameter Block of a FAT16 volume.
 * Structural validation only: no data region access happens here.
 */
export function readBpb(buf: Buffer): BpbReadResult {
  const issues: CheckIssue[] = [];
  if (buf.length < 512) {
    return {
      issues: [
        {
          code: "IMAGE_TRUNCATED",
          severity: "error",
          message: `Image is only ${buf.length} bytes; a FAT16 boot sector requires at least 512.`,
          offset: buf.length,
        },
      ],
    };
  }

  const bytesPerSector = rd16(buf, 11);
  const sectorsPerCluster = buf[13]!;
  const reservedSectors = rd16(buf, 14);
  const numberOfFats = buf[16]!;
  const rootEntryCount = rd16(buf, 17);
  const totalSectors16 = rd16(buf, 19);
  const media = buf[21]!;
  const fatSize16 = rd16(buf, 22);
  const sectorsPerTrack = rd16(buf, 24);
  const numberOfHeads = rd16(buf, 26);
  const hiddenSectors = buf.readUInt32LE(28);
  const totalSectors32 = buf.readUInt32LE(32);

  const fail = (message: string, offset?: number): void => {
    issues.push({ code: "LAYOUT_INVALID", severity: "error", message, offset });
  };

  const validSectorSizes = [512, 1024, 2048, 4096];
  if (!validSectorSizes.includes(bytesPerSector)) {
    fail(`Unsupported bytesPerSector ${bytesPerSector} (must be 512/1024/2048/4096).`, 11);
  }
  if (![1, 2, 4, 8, 16, 32, 64, 128].includes(sectorsPerCluster)) {
    fail(`Invalid sectorsPerCluster ${sectorsPerCluster}.`, 13);
  }
  if (reservedSectors < 1) fail("reservedSectors must be >= 1.", 14);
  if (numberOfFats < 1) fail("numberOfFats must be >= 1.", 16);
  if (rootEntryCount === 0 || rootEntryCount % 16 !== 0) {
    fail(`rootEntryCount ${rootEntryCount} must be non-zero and a multiple of 16.`, 17);
  }

  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;
  if (totalSectors === 0) fail("Both totalSectors16 and totalSectors32 are zero.", 19);
  if (fatSize16 === 0) fail("fatSize16 must not be zero for FAT16.", 22);
  if (totalSectors16 !== 0 && totalSectors32 !== 0 && totalSectors16 !== totalSectors32) {
    issues.push({
      code: "LAYOUT_INVALID",
      severity: "warning",
      message: `totalSectors16 (${totalSectors16}) and totalSectors32 (${totalSectors32}) disagree; using 16-bit value.`,
      offset: 19,
    });
  }

  const oemName = buf.toString("latin1", 3, 11).trimEnd();
  const rootDirSectors = Math.floor(
    (rootEntryCount * 32 + bytesPerSector - 1) / bytesPerSector,
  );
  const firstFatSector = reservedSectors;
  const rootDirSector = reservedSectors + numberOfFats * fatSize16;
  const firstDataSector = rootDirSector + rootDirSectors;
  const totalClusters = Math.floor(
    (totalSectors - firstDataSector) / sectorsPerCluster,
  );

  // Layout bounds against the actual image file.
  const imageSectors = Math.floor(buf.length / bytesPerSector);
  const fatEndSector = firstFatSector + numberOfFats * fatSize16;
  if (fatEndSector > imageSectors) {
    issues.push({
      code: "IMAGE_TRUNCATED",
      severity: "error",
      message: `FAT region ends at sector ${fatEndSector} but image only provides ${imageSectors} sectors.`,
      sector: fatEndSector,
      offset: fatEndSector * bytesPerSector,
    });
  }
  const rootEndSector = rootDirSector + rootDirSectors;
  if (rootEndSector > imageSectors) {
    issues.push({
      code: "IMAGE_TRUNCATED",
      severity: "error",
      message: `Fixed root directory ends at sector ${rootEndSector} but image ends at ${imageSectors}.`,
      sector: rootEndSector,
    });
  }
  const dataEndSector = firstDataSector + totalClusters * sectorsPerCluster;
  if (dataEndSector > imageSectors) {
    issues.push({
      code: "IMAGE_TRUNCATED",
      severity: "error",
      message: `Data region claims ${totalClusters} clusters ending at sector ${dataEndSector} but image ends at ${imageSectors}.`,
      sector: dataEndSector,
    });
  }

  if (totalClusters < 4085 || totalClusters > 65524) {
    issues.push({
      code: "NOT_FAT16",
      severity: "error",
      message: `Computed cluster count ${totalClusters} is outside the FAT16 range [4085, 65524].`,
    });
  }

  if (issues.some((i) => i.severity === "error")) {
    return { issues };
  }

  const params: VolumeParams = {
    oemName,
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numberOfFats,
    rootEntryCount,
    totalSectors16,
    media,
    fatSize16,
    sectorsPerTrack,
    numberOfHeads,
    hiddenSectors,
    totalSectors32,
    rootDirSectors,
    firstFatSector,
    rootDirSector,
    firstDataSector,
    totalClusters,
    fatType: "FAT16",
  };
  return { params, issues };
}
