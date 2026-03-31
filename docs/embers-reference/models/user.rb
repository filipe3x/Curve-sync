class User < ApplicationRecord
  include Mongoid::Document
  include Mongoid::Timestamps
  include Mongoid::Paperclip

  field :email
  field :encrypted_password
  field :salt
  field :role, default: 'user'
  field :created_at
  field :updated_at
  field :last_activity_at, type: DateTime

  #has_many :assets ##assets a mostrar e assets escondidos
  has_many :addresses
  has_many :sessions
  has_many :goals
  has_many :expenses
  has_and_belongs_to_many :assets
  has_many :evolutions, dependent: :destroy

  has_mongoid_attached_file :avatar, default_url: "/images/missing.png"

  ROLES = %w(admin user)
  
  #accepts_nested_attributes_for :addresses, allow_destroy: true
  
  attr_accessor :password, :password_confirmation

  validates_attachment :avatar, content_type: { content_type: ['image/jpeg', 'image/png'] }
  validates :email, uniqueness: {case_sensitive: false, message: 'This email address is already registered.'},
            format: {with: /.*\@.*\..*/, message: 'is incorrect'},
            presence: true

  validates_inclusion_of :role, in: ROLES

  before_save :encrypt_password
  before_validation :downcase_email

  validates :password, presence: true, confirmation: true, if: :validate_password?
  validates :password_confirmation, presence: true, if: :validate_password?

  scope :admins, -> {where(role: 'admin')}
  scope :user, -> {where(role: 'user')}

  after_initialize :set_defaults

  ROLES.each do |role_name|
    define_method("#{role_name}?") {role === role_name}
  end

  def to_json_login
    {
        id: id.to_s,
        email: email,
        avatar: avatar
    }
  end

  def to_json
    {
        id: id.to_s,
        email: email,
        avatar: avatar
    }
  end

  def to_short_json
    {
        id: id.to_s,
        email: email
    }
  end

  def self.search_query(params)
    query_params = {}

    query_params[:id] = params[:id] if params[:id].present?
    query_params[:email] = %r{.*#{params[:email]}.*}i if params[:email].present?

    sort_column = params[:sort_column] || :created_at
    sort_type = params[:sort_type] || :desc

    User.where(query_params)
        .order(sort_column => sort_type)
  end

  def authenticate(password)
    self.encrypted_password == encrypt(password)
  end

  def destroy
    raise "#{Time.now} = Cannot destroy last admin #{self.email}" if self.admin? && User.admins.count <= 1
    super
  end

  private

  ## nao funciona? NoMethodError: undefined method `_id' for BSON::ObjectId('5e2dcf4b1d41c80bbf297953'):BSON::ObjectId
  def set_defaults
    if self.assets.empty?
      self.assets ||= self.addresses.where(enabled: true).distinct(:asset)
    end
  end

  def user_encrypt_password(password)
    self.salt = make_salt if salt.blank?
    self.encrypted_password = encrypt(self.password)
  end

  def validate_password?
    password.present? || password_confirmation.present?
  end

  def downcase_email
    self.email = self.email.downcase if self.email
  end

  def encrypt_password
    self.salt = make_salt if salt.blank?
    self.encrypted_password = encrypt(self.password) if self.password
  end

  def encrypt(string)
    secure_hash("#{string}--#{self.salt}")
  end

  def make_salt
    secure_hash("#{Time.now.utc}--#{self.password}")
  end

  def secure_hash(string)
    Digest::SHA2.hexdigest(string)
  end

end