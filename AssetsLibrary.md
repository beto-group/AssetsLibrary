---
cssclasses:
  - assets-library
---

```datacorejsx
const { View } = await dc.require(dc.resolvePath("AssetsLibrary/src/index.jsx"));
return View({ folderPath: dc.resolvePath("AssetsLibrary") });
```
