import db from "../db.server";

export interface PlatformSettingsData {
  supportEmail: string;
  supportPhone: string;
  supportWhatsApp: string;
  supportHours: string;
}

const DEFAULT_SETTINGS: PlatformSettingsData = {
  supportEmail: "support@everonlab.in",
  supportPhone: "+91 93746 26600",
  supportWhatsApp: "919374626600",
  supportHours: "Monday - Saturday: 9:00 AM - 8:00 PM IST",
};

/**
 * Retrieves the global platform support settings from the database.
 * If not initialized yet, creates and returns the default row.
 */
export async function getPlatformSettings(): Promise<PlatformSettingsData & { id: string; updatedAt: Date }> {
  try {
    let settings = await db.platformSetting.findFirst();
    if (!settings) {
      settings = await db.platformSetting.create({
        data: {
          id: "global",
          ...DEFAULT_SETTINGS,
        },
      });
    }
    return settings;
  } catch (error) {
    console.error("[PlatformSettings] Failed to fetch settings, using defaults:", error);
    return {
      id: "global",
      ...DEFAULT_SETTINGS,
      updatedAt: new Date(),
    };
  }
}

/**
 * Updates the global platform support settings (Super Admin only).
 */
export async function updatePlatformSettings(data: Partial<PlatformSettingsData>) {
  const current = await getPlatformSettings();
  return db.platformSetting.update({
    where: { id: current.id },
    data: {
      ...(data.supportEmail ? { supportEmail: data.supportEmail.trim() } : {}),
      ...(data.supportPhone ? { supportPhone: data.supportPhone.trim() } : {}),
      ...(data.supportWhatsApp ? { supportWhatsApp: data.supportWhatsApp.replace(/[^0-9]/g, "") } : {}),
      ...(data.supportHours ? { supportHours: data.supportHours.trim() } : {}),
    },
  });
}
