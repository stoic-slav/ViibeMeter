import { requireOptionalNativeModule } from 'expo';

interface StoryShareNative {
  canShareToInstagram(): Promise<boolean>;
  shareToInstagramStory(fileUri: string, appId: string, topColor: string, bottomColor: string): Promise<boolean>;
}

// iOS only. Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<StoryShareNative>('ViibeStoryShare');

/** Instagram is installed and accepts Story shares. */
export async function canShareToInstagram(): Promise<boolean> {
  try {
    return (await native?.canShareToInstagram()) ?? false;
  } catch {
    return false;
  }
}

/** Opens Instagram on a new Story with the image as background. `appId`: the Meta App ID. */
export async function shareToInstagramStory(fileUri: string, appId: string, topColor: string, bottomColor: string): Promise<boolean> {
  try {
    return (await native?.shareToInstagramStory(fileUri, appId, topColor, bottomColor)) ?? false;
  } catch {
    return false;
  }
}
