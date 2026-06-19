const apiKeyVerifyHashSanitizer = `(function(){
  var tokenPrefix = "akv_";
  var storageKey = "pharos:api-key-verify-token";
  var hash = window.location.hash || "";
  var rawHash = hash.charAt(0) === "#" ? hash.slice(1) : hash;
  if (rawHash.indexOf(tokenPrefix) !== 0) return;
  var token = null;
  try {
    token = decodeURIComponent(rawHash).trim();
  } catch (error) {
    token = null;
  }
  if (!token || token.indexOf(tokenPrefix) !== 0) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    window.sessionStorage.setItem(storageKey, token);
  } catch (error) {
    window.location.hash = token;
  }
})();`;

export default function ApiAccessLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <script
        id="api-key-verify-hash-sanitizer"
        dangerouslySetInnerHTML={{ __html: apiKeyVerifyHashSanitizer }}
      />
      {children}
    </>
  );
}
