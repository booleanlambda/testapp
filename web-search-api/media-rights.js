function clean(value, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function meaningfulLicense(value) {
  const normalized = clean(value, 200).toLowerCase();
  return !["", "unknown", "none", "n/a", "na", "unspecified", "not specified"].includes(normalized);
}

function inferAttributionRequirement(licenseText = "", licenseUrl = "") {
  const effectiveLicense = meaningfulLicense(licenseText) ? licenseText : "";
  const hay = `${effectiveLicense} ${licenseUrl || ""}`.toLowerCase();
  if (!hay.trim()) return null;
  if (/\bcc0\b|public[ _-]?domain|creativecommons\.org\/publicdomain/.test(hay)) return false;
  if (
    /\bcc[ _-]?by\b|\bcc[ _-]?by[ _-]?sa\b|\bcc[ _-]?by[ _-]?nd\b|\bcc[ _-]?by[ _-]?nc\b|creativecommons\.org\/licenses\/by/.test(hay)
  ) return true;
  return null;
}

function inferCopyrightStatus(licenseText = "", licenseUrl = "", copyrightNotice = "") {
  const effectiveLicense = meaningfulLicense(licenseText) ? licenseText : "";
  const hay = `${effectiveLicense} ${licenseUrl || ""}`.toLowerCase();
  if (/\bcc0\b|public[ _-]?domain|creativecommons\.org\/publicdomain/.test(hay)) {
    return "public_domain_or_cc0_claimed";
  }
  if (/creative[ _-]?commons|\bcc[ _-]?by\b|creativecommons\.org\/licenses/.test(hay)) {
    return "creative_commons_claimed";
  }
  if (meaningfulLicense(licenseText) || cleanUrl(licenseUrl)) return "license_metadata_present";
  if (clean(copyrightNotice)) return "copyright_notice_present";
  return "unknown";
}

export function buildRightsMetadata(input = {}) {
  const rawLicense = clean(input.license, 200);
  const license = meaningfulLicense(rawLicense) ? rawLicense : "unknown";
  const licenseUrl = cleanUrl(input.license_url || input.licenseUrl);
  const creator = clean(input.creator || input.author, 300) || null;
  const creatorUrl = cleanUrl(input.creator_url || input.creatorUrl);
  const copyrightNotice =
    clean(input.copyright_notice || input.copyrightNotice || input.copyright, 500) || null;
  const attributionText =
    clean(input.attribution_text || input.attributionText, 800) || null;
  const attributionRequired =
    typeof input.attribution_required === "boolean"
      ? input.attribution_required
      : inferAttributionRequirement(license, licenseUrl);

  return {
    license,
    license_url: licenseUrl,
    copyright_status: inferCopyrightStatus(license, licenseUrl, copyrightNotice),
    copyright_notice: copyrightNotice,
    creator,
    creator_url: creatorUrl,
    attribution_required: attributionRequired,
    attribution_text: attributionText,
    rights_verified: false,
    verification_note:
      "Rights metadata is discovery metadata, not legal verification. Verify the source page before reuse or redistribution."
  };
}
