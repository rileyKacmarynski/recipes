data "aws_caller_identity" "current" {}

locals {
  tags = {
    Project     = "recipes"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
