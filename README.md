# MaxGreen Agent — Local Integration Build v23

Start with **START_HERE.md**.

Folder layout:

```text
project/
├── START_HERE.md
├── .gitignore
├── .env.example
│
├── frontend/      # Existing HTML/CSS/JavaScript app
│   ├── index.html
│   ├── inbox.html
│   ├── gmail-test.html
│   └── assets/
│
└── backend/       # New Python/FastAPI Gmail backend
    ├── app.py
    ├── gmail_auth.py
    ├── test_gmail.py
    ├── requirements.txt
    ├── setup_windows.bat
    ├── connect_gmail.bat
    ├── test_gmail.bat
    ├── start_backend.bat
    ├── services/
    ├── data/
    └── secrets/
```

Current milestone: Gmail read-only connection locally. Claude and AWS deployment come later.
