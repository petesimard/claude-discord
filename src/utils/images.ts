import { Attachment } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Downloads an image from a URL and saves it to the specified directory
 * @param url The URL of the image to download
 * @param targetDir The directory to save the image to
 * @param filename The filename to use for the saved image
 * @returns Promise that resolves to the full path of the saved image
 */
async function downloadImage(url: string, targetDir: string, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const filePath = path.join(targetDir, filename);
    const file = fs.createWriteStream(filePath);

    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });

      file.on('error', (err) => {
        fs.unlink(filePath, () => { }); // Delete partial file
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => { }); // Delete partial file
      reject(err);
    });
  });
}

/**
 * Processes image attachments from a Discord message
 * Downloads images and saves them to the working directory
 * @param attachments The Discord message attachments
 * @param workingPath The working directory to save images to
 * @returns Promise that resolves to an array of saved image paths with their descriptions
 */
export async function processImageAttachments(
  attachments: Attachment[],
  workingPath: string
): Promise<{ path: string; originalName: string; description: string }[]> {
  const imageAttachments = attachments.filter(attachment =>
    attachment.contentType?.startsWith('image/')
  );

  if (imageAttachments.length === 0) {
    return [];
  }

  console.log(`[Images] Processing ${imageAttachments.length} image attachment(s)`);

  const savedImages: { path: string; originalName: string; description: string }[] = [];

  // Create a subdirectory for attachments if it doesn't exist
  const attachmentsDir = path.join(workingPath, '.discord-attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  for (const attachment of imageAttachments) {
    try {
      // Generate a safe filename with timestamp to avoid conflicts
      const timestamp = Date.now();
      const ext = path.extname(attachment.name || '.png');
      const baseName = path.basename(attachment.name || 'image', ext);
      const safeFilename = `${timestamp}-${baseName}${ext}`;

      console.log(`[Images] Downloading ${attachment.name} from ${attachment.url}`);

      const savedPath = await downloadImage(attachment.url, attachmentsDir, safeFilename);
      const relativePath = path.relative(workingPath, savedPath);

      console.log(`[Images] Saved to ${savedPath}`);

      // Extract description if available
      const description = attachment.description || attachment.name || 'Attached image';

      savedImages.push({
        path: relativePath,
        originalName: attachment.name || 'image',
        description
      });
    } catch (error) {
      console.error(`[Images] Failed to download ${attachment.name}:`, error);
      // Continue processing other images even if one fails
    }
  }

  return savedImages;
}

/**
 * Generates a prompt addon that describes the attached images
 * @param images The processed image information
 * @returns A string to append to the user's prompt
 */
export function generateImagePromptAddition(
  images: { path: string; originalName: string; description: string }[]
): string {
  if (images.length === 0) {
    return '';
  }

  const imageDescriptions = images.map((img, index) => {
    const num = images.length > 1 ? ` ${index + 1}` : '';
    return `Image${num}: ${img.path} (${img.description})`;
  }).join('\n');

  return `\n\n[User attached ${images.length} image(s) to this message. The images have been saved to the working directory:]\n${imageDescriptions}\n[Please analyze the image(s) and respond to the user's request.]`;
}
