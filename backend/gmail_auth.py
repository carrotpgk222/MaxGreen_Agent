from services.gmail_service import authorize_interactive, get_profile


def main() -> None:
    print("Connecting to Gmail...")
    print("Do NOT enter your Gmail password into this terminal. Sign in only on Google's page.\n")
    authorize_interactive()
    profile = get_profile()
    print("\nGmail connected successfully!")
    print(f"Connected account: {profile['email']}")
    print("A private token.json file was created in backend/secrets/.")
    print("Do not upload credentials.json or token.json to GitHub or send them to anyone.")


if __name__ == "__main__":
    main()
