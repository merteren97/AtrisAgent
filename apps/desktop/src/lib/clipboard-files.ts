export function extractClipboardFiles(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  const seen = new Set<string>();

  // 1. Check items (handles screenshots from Snipping Tool, PrintScreen, browser image copy)
  if (clipboardData.items?.length) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          const key = `${file.name}-${file.size}-${file.lastModified}`;
          if (!seen.has(key)) {
            let name = file.name;
            if (!name || name === 'image.png' || name === 'blob') {
              const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
              name = `pasted-image-${Date.now()}-${i + 1}.${ext}`;
            }
            files.push(new File([file], name, { type: file.type || 'image/png', lastModified: Date.now() }));
            seen.add(key);
          }
        }
      }
    }
  }

  // 2. Check files (handles files copied from file explorer or desktop)
  if (clipboardData.files?.length) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (!seen.has(key)) {
        files.push(file);
        seen.add(key);
      }
    }
  }

  return files;
}
