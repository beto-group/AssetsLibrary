---
cssclasses:
  - assets-library
---

```datacorejsx
const { View } = await dc.require(dc.resolvePath("ASSETS LIBRARY/src/index.jsx"));
return View({ folderPath: dc.resolvePath("ASSETS LIBRARY") });
```
