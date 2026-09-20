from services.gmail_service import get_profile, fetch_latest_messages


def main() -> None:
    profile = get_profile()
    print(f"Connected Gmail: {profile['email']}\n")
    messages = fetch_latest_messages(limit=10)
    print(f"Fetched {len(messages)} Inbox messages.\n")
    for i, msg in enumerate(messages, 1):
        print("=" * 72)
        print(f"{i}. {msg['subject']}")
        print(f"From: {msg['sender']} <{msg['sender_email']}>")
        print(f"Received: {msg['received_at']}")
        print(f"Attachments: {len(msg['attachments'])}")
        preview = (msg['body_text'] or msg['snippet']).replace("\n", " ")[:250]
        print(f"Preview: {preview}")
    print("\nSuccess: Gmail read-only access is working.")


if __name__ == "__main__":
    main()
