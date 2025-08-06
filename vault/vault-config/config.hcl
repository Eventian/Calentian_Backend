listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

storage "file" {
  path = "/vault/file"
}

api_addr = "https://vault.calentian.de"
cluster_addr = "https://0.0.0.0:8201"

ui = true
disable_mlock = true
