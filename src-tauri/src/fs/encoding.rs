//! Legacy text encodings (D204): writing the WHATWG encodings the webview can only decode (Shift
//! JIS, EUC-JP, ISO-2022-JP, GBK, GB 18030, Big5, EUC-KR and the single-byte ones) through
//! `encoding_rs`, and guessing a file's encoding with `chardetng` (Firefox's detector) for
//! `files.autoGuessEncoding`. Decoding stays in the webview's `TextDecoder`, which implements the
//! same WHATWG tables, so what is read and what is written agree.

use encoding_rs::Encoding;

/// How much of a file the detector reads: enough for a stable guess, bounded for huge files.
const GUESS_LIMIT: usize = 256 * 1024;

/// Characters an encoding can't hold (the first few, each once).
#[derive(Debug, PartialEq, Eq)]
pub struct Unencodable(pub Vec<char>);

/// The encoding for a WHATWG label (`shift_jis`, `gbk`, `windows-1252`…), case-insensitive.
pub fn for_label(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label_no_replacement(label.trim().as_bytes())
}

/// Text → bytes in `encoding`, with no replacement: characters it can't hold are returned instead
/// (up to five), so a save never silently writes `&#NNNN;` or `?` into the file.
pub fn encode(text: &str, encoding: &'static Encoding) -> Result<Vec<u8>, Unencodable> {
    // UTF-16 has no encoder in encoding_rs (the WHATWG spec writes UTF-8 instead); the front end
    // writes UTF-16 itself, but answer correctly here too.
    if encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE {
        let le = encoding == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            let bytes = if le {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            out.extend_from_slice(&bytes);
        }
        return Ok(out);
    }
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(
        encoder
            .max_buffer_length_from_utf8_without_replacement(text.len())
            .unwrap_or(text.len() * 4),
    );
    let mut bad: Vec<char> = Vec::new();
    let mut rest = text;
    loop {
        let (result, read) =
            encoder.encode_from_utf8_to_vec_without_replacement(rest, &mut out, true);
        rest = &rest[read..];
        match result {
            encoding_rs::EncoderResult::InputEmpty => break,
            encoding_rs::EncoderResult::OutputFull => {
                out.reserve(rest.len() * 4 + 16);
            }
            encoding_rs::EncoderResult::Unmappable(ch) => {
                if !bad.contains(&ch) {
                    bad.push(ch);
                }
                if bad.len() >= 5 {
                    break;
                }
            }
        }
    }
    if bad.is_empty() {
        Ok(out)
    } else {
        Err(Unencodable(bad))
    }
}

/// The encoding `bytes` most likely are in (a lower-case WHATWG name such as `shift_jis`,
/// `gbk`, `windows-1252`), or None for plain ASCII (any encoding reads it the same).
/// UTF-8 is a possible answer: the caller only asks for bytes that aren't valid UTF-8, but a
/// truncated sample may still look like it.
pub fn guess(bytes: &[u8]) -> Option<String> {
    let sample = &bytes[..bytes.len().min(GUESS_LIMIT)];
    if sample.is_ascii() {
        return None;
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(sample, sample.len() == bytes.len());
    let found = detector.guess(None, chardetng::Utf8Detection::Allow);
    Some(found.name().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(label: &str, text: &str) {
        let enc = for_label(label).expect("known label");
        let bytes = encode(text, enc).expect("encodable");
        let (back, _, had_errors) = enc.decode(&bytes);
        assert!(!had_errors, "{label}: decode errors");
        assert_eq!(back, text, "{label}: round trip");
        // And bytes → text → bytes is byte-identical.
        let (decoded, _, _) = enc.decode(&bytes);
        assert_eq!(
            encode(&decoded, enc).expect("again"),
            bytes,
            "{label}: bytes"
        );
    }

    #[test]
    fn multi_byte_round_trips() {
        round_trip("shift_jis", "こんにちは、世界。カタカナ ﾊﾝｶｸ abc\r\n");
        round_trip("euc-jp", "日本語のテキスト\n");
        round_trip("iso-2022-jp", "日本語 and ASCII\n");
        round_trip("gbk", "简体中文测试\n");
        round_trip("gb18030", "简体中文 😀 €\n");
        round_trip("big5", "繁體中文測試\n");
        round_trip("euc-kr", "한국어 텍스트\n");
        round_trip("windows-1251", "Привет\n");
        round_trip("koi8-u", "Привіт\n");
    }

    #[test]
    fn known_shift_jis_bytes() {
        let enc = for_label("Shift_JIS").expect("label");
        assert_eq!(
            encode("日本", enc).expect("ok"),
            vec![0x93, 0xfa, 0x96, 0x7b]
        );
        assert_eq!(for_label("sjis"), Some(encoding_rs::SHIFT_JIS));
        assert_eq!(for_label("nonsense"), None);
    }

    #[test]
    fn unencodable_characters_are_reported_not_replaced() {
        let enc = for_label("shift_jis").expect("label");
        let err = encode("日本 😀 € 😀", enc).expect_err("emoji can't be Shift JIS");
        assert_eq!(err.0, vec!['😀', '€']);
        let latin = for_label("windows-1252").expect("label");
        assert_eq!(encode("日", latin), Err(Unencodable(vec!['日'])));
    }

    #[test]
    fn utf16_is_written() {
        assert_eq!(
            encode("a€", encoding_rs::UTF_16LE).expect("ok"),
            vec![0x61, 0, 0xac, 0x20]
        );
        assert_eq!(
            encode("a", encoding_rs::UTF_16BE).expect("ok"),
            vec![0, 0x61]
        );
    }

    #[test]
    fn guesses_legacy_encodings() {
        let text = "これは日本語のテキストです。エンコーディングの推測をテストしています。\
                    ひらがな、カタカナ、漢字が混ざった普通の文章です。";
        let sjis = encode(text, encoding_rs::SHIFT_JIS).expect("ok");
        assert_eq!(guess(&sjis).as_deref(), Some("shift_jis"));
        let eucjp = encode(text, encoding_rs::EUC_JP).expect("ok");
        assert_eq!(guess(&eucjp).as_deref(), Some("euc-jp"));
        let zh = "这是一个简体中文的文本，用于测试编码的自动检测功能。我们希望它能正确识别。";
        assert_eq!(
            guess(&encode(zh, encoding_rs::GBK).expect("ok")).as_deref(),
            Some("gbk")
        );
        let tw = "這是一個繁體中文的文本，用於測試編碼的自動檢測功能。我們希望它能正確識別。";
        assert_eq!(
            guess(&encode(tw, encoding_rs::BIG5).expect("ok")).as_deref(),
            Some("big5")
        );
        let ko = "이것은 한국어 텍스트입니다. 인코딩 자동 감지 기능을 시험하고 있습니다.";
        assert_eq!(
            guess(&encode(ko, encoding_rs::EUC_KR).expect("ok")).as_deref(),
            Some("euc-kr")
        );
        let fr = "Les élèves étudient à l'école; ça coûte très cher, déjà côté café.";
        assert_eq!(
            guess(&encode(fr, encoding_rs::WINDOWS_1252).expect("ok")).as_deref(),
            Some("windows-1252")
        );
        let ru = "Это русский текст для проверки автоматического определения кодировки.";
        assert_eq!(
            guess(&encode(ru, encoding_rs::WINDOWS_1251).expect("ok")).as_deref(),
            Some("windows-1251")
        );
        assert_eq!(guess(b"plain ascii"), None);
        // A short Western file (a single accented letter) stays Windows-1252.
        assert_eq!(guess(b"caf\xe9\n").as_deref(), Some("windows-1252"));
        // The UI test's Shift JIS file (two lines of Japanese).
        let ja = "これは日本語のテキストです。エンコーディングの推測をテストしています。\n\
                  ひらがな、カタカナ、漢字が混ざった普通の文章です。\n";
        let bytes = encode(ja, encoding_rs::SHIFT_JIS).expect("ok");
        assert_eq!(bytes.len(), 122);
        assert_eq!(guess(&bytes).as_deref(), Some("shift_jis"));
    }
}
