{
  "id": "__ID__",
  "version": "0.1.0",
  "displayName": "__TITLE__",
  "description": "__DESCRIPTION__",
  "authors": __AUTHORS__,
  "icon": "box",
  "categories": ["Other"],
  "main": "main.js",
  "activation": ["*"],
  "permissions": [],
  "contributes": {
    "commands": [
      { "id": "__PREFIX__.hello", "title": "__TITLE__: say hello", "description": "Shows a greeting.", "effects": [] }
    ],
    "views": [
      { "id": "__PREFIX__.items", "title": "__TITLE__", "location": "sidebar", "type": "tree", "icon": "box" }
    ],
    "menus": [
      { "location": "view/title", "command": "__PREFIX__.hello", "icon": "zap", "when": "view == __PREFIX__.items" }
    ]
  }
}
